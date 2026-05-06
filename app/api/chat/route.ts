// app/api/chat/route.ts — V12.5.2 (RIGOR TOTAL: Fixed Duplicates + GPS Override + Modular Geo)
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

export const maxDuration = 60;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY_1 });

// ─── Constantes Globais ──────────────────────────────────────────────────────
const MAX_MSG_CHARS = 800;
const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /filh[oa]/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

/**
 * ─── Gerador de Voz (OpenAI TTS) ─────────────────────────────────────────────
 * Localização correta: Fora do Handler POST.
 */
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
    // 1. Parse do Body
    const body = await (req.headers.get('content-type')?.includes('multipart') ? req.formData() : req.json());
    const message = (body instanceof FormData ? body.get('message') as string : body.message) || '';
    const userEmail = body instanceof FormData ? body.get('userEmail') as string : body.userEmail;
    const speak = body instanceof FormData ? body.get('speak') === 'true' : !!body.speak;
    const incomingSessionId = body instanceof FormData ? (body.get('sessionId') as string | null) : (body.sessionId as string | null);
    const userLocation = body instanceof FormData ? null : body.location;

    // 2. Resolve Usuário e Sessão
    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!user) return NextResponse.json({ error: 'Auth failed' }, { status: 401 });
    const sessionId = incomingSessionId || await getOrCreateSession(String(user.id));

    // 3. Deduplicação Global (Janela 60s)
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

    // 4. Execução Paralela: God RPC + Geo-Precision
    const [resolvedLocation, { data: masterContext, error: rpcError }] = await Promise.all([
      resolveLocation(userLocation),
      supabase.rpc('get_consolidated_context', { p_user_id: user.id, p_session_id: sessionId }),
    ]);
    if (rpcError) console.error('[RPC FATAL]:', rpcError.message);

    const normalizedLocation = normalizeLocationForModules(resolvedLocation);

    // 5. Histórico (Strict Alternation)
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

    // 6. Processamento Paralelo Inteligente
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

    // 7. Radar de Afeto
    let filteredL3 = memory.l3.content;
    const isHighAlertMonth = [4, 7].includes(new Date().getMonth());
    const hasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(recentHistory.map(h => h.content).join(' ') + message));
    if (!isHighAlertMonth && !hasFamilySignal) {
      filteredL3 = filteredL3.replace(/##\s*(datas?|aniversário|famil[íi]a|cônjuge|esposa|filho)[^\n]*\n[\s\S]*?(?=##|$)/gi, '').trim();
    }

    // 8. Contexto Dinâmico
    const { contextText, activeTools: dynamicTools } = await buildDynamicContext({
      userId: String(user.id), authUserId: user.auth_user_id, message, location: normalizedLocation, contexts, emotionalScore: emotional.score, masterContext,
    });

    // 9. COMPOSIÇÃO DE PROMPT FINAL (MATA DUPLICATAS + GPS OVERRIDE)
    const nowSP = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const dataHoraSP = nowSP.toLocaleString('pt-BR');
    const geoBlock = buildGeoBlock(resolvedLocation);
    const urgentes = (masterContext?.reminders || []).map((u: any) => u.title).join(', ');

    // Blindagem Anti-Cornélio Procópio
    const gpsOverrideInstruction = resolvedLocation 
      ? `\n[DIRETRIZ CRÍTICA]: O usuário está REALMENTE em: ${resolvedLocation.label || 'Londrina'}. Ignore qualquer endereço divergente do histórico.`
      : '';

    const systemPrompt = `[RELÓGIO DO SISTEMA]: ${dataHoraSP}
${geoBlock}${gpsOverrideInstruction}
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
2. Atue como Arquiteto do Expert Frotas/Procuro Quem Faça. Jamais responda apenas "Pronto".`;

    // 10. Ciclo LLM
    const toolsHabilitadas = ALL_TOOLS.filter(t => activeTools.includes(t.function.name) || dynamicTools.includes(t.function.name));
    const conversationMessages = [{ role: 'system', content: systemPrompt }, ...recentHistory, { role: 'user', content: message }];

    const firstResponse = await callOpenRouterWithPriority(1, 'never', requestSignature, conversationMessages, toolsHabilitadas, finalModel, 0.7);
    let assistantReply = firstResponse.content || "Entendido.";

    if (firstResponse.toolCalls && firstResponse.toolCalls.length > 0) {
      const toolResults = await Promise.all(firstResponse.toolCalls.map(async (tc) => ({ tc, result: await executeTool(tc, user.auth_user_id, String(user.id)) })));
      const secondResponse = await callOpenRouterWithPriority(1, 'never', `${requestSignature}_synth`, [
        ...conversationMessages,
        { role: 'assistant', content: firstResponse.content || null, tool_calls: firstResponse.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } })) },
        ...toolResults.map(({ tc, result }) => ({ role: 'tool', tool_call_id: tc.id, content: result }))
      ], [], finalModel, 0.7);
      assistantReply = secondResponse.content || assistantReply;
    }

    // 11. Finalização
    await redis.set(replyKey, assistantReply, { ex: 60 }).catch(() => {});
    (async () => {
      supabase.from('brain').insert({
        user_id: Number(user.id), session_id: sessionId, content: message, category: message.length < 15 ? 'noise' : 'info',
        metadata: { role: 'user', ai_reply: assistantReply, contexts, model: finalModel }
      }).then(() => {});
      extractAndSummarize(String(user.id), user.nickname, message, assistantReply).catch(() => {});
    })();

    const audioBase64 = speak ? await generateTTS(assistantReply, user.preferred_voice || 'alloy') : null;

    return NextResponse.json({
      reply: assistantReply, audioBase64, ok: true, sessionId, performance: `${Date.now() - startTime}ms`,
    });

  } catch (e: any) {
    console.error('[FATAL ERROR]:', e);
    return NextResponse.json({ error: 'Erro no motor do Jarvis.' }, { status: 500 });
  }
}
