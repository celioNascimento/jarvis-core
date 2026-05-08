// app/api/chat/route.ts — V12.6.3 (RIGOR TOTAL: Fortaleza Restaurada + Universal Extractor + Radar)
import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { supabase, getOrCreateSession } from '@/lib/jarvis';
import { classifyContextWithL4 } from '@/lib/chat/context-classifier';
import { computeEmotionalScore } from '@/lib/chat/emotional-router';
import { MemoryManager } from '@/lib/memory';
import { callOpenRouterWithPriority, llmGateway } from '@/lib/chat/llm-gateway';
import { loadActiveModules } from '@/lib/modules/registry';
import { composeSystemPrompt } from '@/lib/chat/prompt-engine';
import { tools as ALL_TOOLS } from '@/lib/chat/tools-def';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import { executeTool } from '@/lib/chat/tools-executor';
import OpenAI from 'openai';
import { extractAndSummarize } from '@/lib/extractor';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import {
  resolveLocation,
  normalizeLocationForModules,
  buildGeoBlock
} from '@/lib/geo-resolver';
import { verificarAlertasDeProximidade } from '@/lib/geo';

export const maxDuration = 60;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY_1 });

const MAX_MSG_CHARS = 800;
const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /filh[oa]/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

// ─── Gerador de Voz (OpenAI TTS) ─────────────────────────────────────────────
async function generateTTS(text: string, voice: string = 'alloy'): Promise<string | null> {
  try {
    const cleanText = text.replace(/[*#_~]/g, '').trim();
    if (!cleanText) return null;
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: voice as any,
      input: cleanText,
    });
    return Buffer.from(await mp3.arrayBuffer()).toString('base64');
  } catch (e) {
    console.error('[TTS Error]:', e);
    return null;
  }
}

// ─── Handler principal ────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    // ── 1. EXTRATOR UNIVERSAL (Garante GPS em JSON ou FormData) ──
    const contentType = req.headers.get('content-type') || '';
    const isMultipart = contentType.includes('multipart');
    const body = await (isMultipart ? req.formData() : req.json());

    const message = (isMultipart ? body.get('message') as string : body.message) || '';
    const userEmail = (isMultipart ? body.get('userEmail') as string : body.userEmail) || '';
    const speak = isMultipart ? body.get('speak') === 'true' : !!body.speak;
    const incomingSessionId = isMultipart ? (body.get('sessionId') as string | null) : (body.sessionId as string | null);

    const rawLocation = isMultipart ? body.get('location') : body.location;
    let userLocation = null;

    if (rawLocation) {
      try {
        const parsed = typeof rawLocation === 'string' ? JSON.parse(rawLocation) : rawLocation;

        // ── NORMALIZAÇÃO UNIVERSAL ──
        if (parsed && typeof parsed === 'object') {
          userLocation = {
            lat: parsed.lat ?? parsed.latitude,
            lng: parsed.lng ?? parsed.longitude ?? parsed.lon,
            label: parsed.label,
            city: parsed.city
          };
        }
      } catch (e) {
        console.warn('[Parser] Erro ao processar location JSON');
      }
    }

    console.log(`[DEBUG GPS] Payload Identificado:`, {
      hasLocation: !!userLocation,
      lat: userLocation?.lat,
      lng: userLocation?.lng
    });

    // ── 2. Resolve Usuário e Sessão ──
    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!user) return NextResponse.json({ error: 'Auth failed' }, { status: 401 });
    const sessionId = incomingSessionId || await getOrCreateSession(String(user.id));

    // ── 3. Deduplicação Global (Janela 60s) ──
    const timeSlot = Math.floor(Date.now() / 60000);
    const requestSignature = `${sessionId}_${Buffer.from(message.substring(0, 40)).toString('base64')}_${timeSlot}`;
    const dedupKey = `chat_dedup:${requestSignature}`;
    const replyKey = `chat_reply:${requestSignature}`;

    const isFirst = await redis.set(dedupKey, '1', { nx: true, ex: 60 });
    if (!isFirst) {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const cached = await redis.get<string>(replyKey);
        if (cached) return NextResponse.json({ reply: cached, ok: true, sessionId, performance: '0ms (cache)' });
      }
    }

    // ── 4. Execução Paralela: God RPC + Geo-Precision ──
    const [resolvedLocation, { data: masterContext, error: rpcError }] = await Promise.all([
      resolveLocation(userLocation),
      supabase.rpc('get_consolidated_context', { p_user_id: user.id, p_session_id: sessionId }),
    ]);
    if (rpcError) console.error('[RPC FATAL]:', rpcError.message);

    const normalizedLocation = normalizeLocationForModules(resolvedLocation);

    // ── 5. Histórico (Strict Alternation) ──
    const rawHistory = masterContext?.history || [];
    const recentHistory: any[] = [];
    let lastAddedRole: string | null = null;
    for (const row of [...rawHistory].reverse()) {
      const uMsg = (row.content || '').trim();
      const aRep = (row.metadata?.ai_reply || '').trim();
      if (uMsg.length > 2 && lastAddedRole !== 'user') {
        recentHistory.push({ role: 'user', content: uMsg.slice(0, MAX_MSG_CHARS) });
        lastAddedRole = 'user';
      }
      if (aRep.length > 2 && lastAddedRole !== 'assistant') {
        recentHistory.push({ role: 'assistant', content: aRep.slice(0, MAX_MSG_CHARS) });
        lastAddedRole = 'assistant';
      }
    }
    if (lastAddedRole === 'user') recentHistory.pop();

    // ── 6. Processamento de Inteligência Paralelo ──
    const [queryEmbedding, isStressed, contexts] = await Promise.all([
      getCachedEmbedding(message).catch(() => null),
      llmGateway.isOverloaded(),
      classifyContextWithL4(message, String(user.id)),
    ]);

    const memory = await MemoryManager.read({
      userId: String(user.id), authUserId: user.auth_user_id, sessionId, message, contexts,
      emotionalScore: 0, authorName: user.nickname, assistantName: user.assistant_name,
      queryEmbedding, masterContext,
    });

    const emotional = await computeEmotionalScore(message, String(user.id), memory.hd.memories ?? [], memory.ram.ramBlock ?? '');

    const { contextBlocks, activeTools, resolvedModel } = await loadActiveModules(
      { userId: String(user.id), authUserId: user.auth_user_id, message, contexts, emotionalScore: emotional.score, location: normalizedLocation, masterContext },
      user.plan || 'free', 'google/gemini-2.0-flash-001'
    );

    const finalModel = (typeof resolvedModel === 'string' && resolvedModel.length > 0) ? resolvedModel : 'google/gemini-2.0-flash-001';

    // ── 7. Radar Proativo ──
    let alertaRadar = '';
    if (resolvedLocation?.lat && resolvedLocation?.lng) {
      const radar = await verificarAlertasDeProximidade(String(user.id), Number(resolvedLocation.lat), Number(resolvedLocation.lng));
      if (radar.temAlerta) alertaRadar = `\n[ALERTA RADAR]: ${radar.mensagem}`;
    }

    // ── 8. Radar de Afeto ──
    let filteredL3 = memory.l3.content;
    const isHighAlertMonth = [4, 7].includes(new Date().getMonth());
    const hasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(recentHistory.map(h => h.content).join(' ') + message));
    if (!isHighAlertMonth && !hasFamilySignal) {
      filteredL3 = filteredL3.replace(/##\s*(datas?|aniversário|famil[íi]a|cônjuge|esposa|filho)[^\n]*\n[\s\S]*?(?=##|$)/gi, '').trim();
    }

    // ── 9. Contexto Dinâmico ──
    const { contextText, activeTools: dynamicTools } = await buildDynamicContext({
      userId: String(user.id), authUserId: user.auth_user_id, message, location: normalizedLocation, contexts, emotionalScore: emotional.score, masterContext,
    });

    // ── 10. COMPOSIÇÃO DE PROMPT ──
    const nowSP = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const dataHoraSP = nowSP.toLocaleString('pt-BR');
    const geoBlock = buildGeoBlock(resolvedLocation);
    const urgentes = (masterContext?.reminders || []).map((u: any) => u.title).join(', ');

    const gpsOverrideInstruction = resolvedLocation
      ? `\n[DIRETRIZ CRÍTICA]: O usuário está REALMENTE em: ${resolvedLocation.label || 'Londrina'}. Ignore qualquer endereço divergente do histórico.`
      : `\n[STATUS GPS]: INDISPONÍVEL. Proibido tentar adivinhar a localização atual baseando-se no histórico. Se questionado, diga que não tem o sinal GPS no momento.`;

    const systemPrompt = `[RELÓGIO DO SISTEMA]: ${dataHoraSP}
${geoBlock}${gpsOverrideInstruction}${alertaRadar}
${contextText}${urgentes ? `\n[URGENTE]: Pendências: ${urgentes}` : ''}
---
${composeSystemPrompt({
      assistantName: user.assistant_name, authorName: user.nickname, isLikelyNoise: message.length < 15,
      isSystemStressed: isStressed, emotionalScore: emotional.score, detectedContexts: contexts,
      contextBlocks, memoryBlocks: {
        truncatedL3: filteredL3.slice(0, 3000), truncatedHd: memory.hd.block.slice(0, 4000),
        truncatedEvents: memory.events.block.slice(0, 2000), relationship: memory.relationship.block.slice(0, 2000),
        topics: masterContext?.topics || memory.topics.relatedTopicsBlock,
      },
      canonicalDateTimeBlock: dataHoraSP, canonicalDateISO: nowSP.toISOString().split('T')[0],
      systemWarning: '', intent: 'personal', dynamicGuidelines: (masterContext?.guidelines || []).map((g: any) => `- ${g.content}`).join('\n'),
    })}
[DIRETRIZES DE RIGOR TÉCNICO]
1. Use 'salvar_evento' como fonte primária.
2. Atue como Arquiteto do Expert Frotas/Procuro Quem Faça. Jamais responda "Pronto".`;

    // ── 11. CICLO LLM (Com Execução de Ferramentas) ──
    const toolsHabilitadas = ALL_TOOLS.filter(t => activeTools.includes(t.function.name) || dynamicTools.includes(t.function.name));
    const conversationMessages = [{ role: 'system', content: systemPrompt }, ...recentHistory, { role: 'user', content: message }];

    const firstResponse = await callOpenRouterWithPriority(1, 'never', requestSignature, conversationMessages, toolsHabilitadas, finalModel, 0.7);
    
    let assistantReply = "";

    if (firstResponse.toolCalls && firstResponse.toolCalls.length > 0) {
      // 1ª CORREÇÃO: Tipagem (tc: any) para o compilador
      const toolResults = await Promise.all(
        firstResponse.toolCalls.map(async (tc: any) => ({
          tc,
          result: await executeTool(tc, user.auth_user_id, String(user.id))
        }))
      );

      // 2ª CORREÇÃO: Fechamento de sintaxe e injeção de resultados
      const secondResponse = await callOpenRouterWithPriority(1, 'never', `${requestSignature}_synth`, [
        ...conversationMessages,
        {
          role: 'assistant',
          content: firstResponse.content || null,
          tool_calls: firstResponse.toolCalls.map((tc: any) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments }
          }))
        },
        ...toolResults.map((tr: any) => ({
          role: 'tool',
          tool_call_id: tr.tc.id,
          content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result)
        }))
      ], [], finalModel, 0.7); // Array vazio de ferramentas para evitar loops infinitos

      assistantReply = secondResponse.content || "";
    } else {
      assistantReply = firstResponse.content || "";
    }

    // ── FALLBACK DE EMERGÊNCIA (A "Bronca" no Motor para evitar o "Entendido.") ──
    if (!assistantReply.trim() || assistantReply === "Entendido.") {
      console.warn("[Gatekeeper] Resposta vazia ou genérica detectada. Forçando síntese final...");
      const emergencyResponse = await callOpenRouterWithPriority(1, 'never', `${requestSignature}_panic`, [
        ...conversationMessages,
        { 
          role: 'system', 
          content: "SINTETIZE AGORA: Você obteve dados de ferramentas, mas sua resposta está vazia. Descreva os resultados de forma direta, técnica e proativa como Arquiteto do sistema." 
        }
      ], [], finalModel, 0.3);
      assistantReply = emergencyResponse.content || "Sistema processou a demanda, mas a síntese final falhou. Por favor, tente novamente.";
    }

    // ── 12. FINALIZAÇÃO E BACKGROUND ──
    await redis.set(replyKey, assistantReply, { ex: 60 }).catch(() => { });

    (async () => {
      // Registro no cérebro (Brain)
      supabase.from('brain').insert({
        user_id: Number(user.id), 
        session_id: sessionId, 
        content: message, 
        category: message.length < 15 ? 'noise' : 'info',
        metadata: { role: 'user', ai_reply: assistantReply, contexts, model: finalModel }
      }).then(({ error }) => { if (error) console.error('[Brain Save Error]:', error.message); });

      // Extração de memórias em background
      extractAndSummarize(String(user.id), user.nickname || 'Usuário', message, assistantReply)
        .catch(e => console.error('[Background Extractor Error]:', e));
    })();

    const audioBase64 = speak ? await generateTTS(assistantReply, user.preferred_voice || 'alloy') : null;

    return NextResponse.json({ 
      reply: assistantReply, 
      audioBase64, 
      ok: true, 
      sessionId, 
      performance: `${Date.now() - startTime}ms` 
    });

  } catch (e: any) {
    console.error('[FATAL ERROR]:', e);
    return NextResponse.json({ error: 'Erro no motor do Jarvis.' }, { status: 500 });
  }
}

