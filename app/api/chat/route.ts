// app/api/chat/route.ts — V11.0.0 (RIGOR TOTAL: God RPC + Fix TS Build + Radar de Afeto)
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

export const maxDuration = 60;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY_1 });

// ─── Constantes Globais e Sinais de Contexto ─────────────────────────────────
const MAX_HISTORY_TURNS = 6;
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
      model: "tts-1",
      voice: voice as any,
      input: cleanText,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    return buffer.toString('base64');
  } catch (e) {
    console.error('[TTS Error]:', e);
    return null;
  }
}

// ─── Handler principal ────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    const body = await (req.headers.get('content-type')?.includes('multipart')
      ? req.formData()
      : req.json());

    const message = (body instanceof FormData ? body.get('message') as string : body.message) || '';
    const userEmail = body instanceof FormData ? body.get('userEmail') as string : body.userEmail;
    const speak = body instanceof FormData ? body.get('speak') === 'true' : !!body.speak;
    const incomingSessionId = body instanceof FormData
      ? (body.get('sessionId') as string | null)
      : (body.sessionId as string | null);
    const userLocation = body instanceof FormData ? null : body.location;

    // 1. Resolve Usuário (BIGINT)
    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!user) return NextResponse.json({ error: 'Auth failed' }, { status: 401 });

    const sessionId = incomingSessionId || await getOrCreateSession(String(user.id));

    // ── 2. GOD RPC: UNIFICAÇÃO DE CONTEXTO (MATA N+1) ───────────────────────
    // Buscamos Histórico, Diretrizes, Lembretes, Rotinas e Localizações em 1 pulso.
    const { data: masterContext, error: rpcError } = await supabase
      .rpc('get_consolidated_context', { 
        p_user_id: user.id, 
        p_session_id: sessionId 
      });

    if (rpcError) console.error('[RPC FATAL ERROR]:', rpcError.message);

    // A. Hidratação do Histórico (Mata o getRecentMessages)
    const rawHistory = masterContext?.history || [];
    const recentHistory: any[] = [];
    for (const row of [...rawHistory].reverse()) {
      const uMsg = (row.content || '').trim();
      const aRep = (row.metadata?.ai_reply || '').trim();
      if (uMsg.length > 3) recentHistory.push({ role: 'user', content: uMsg.slice(0, MAX_MSG_CHARS) });
      if (aRep.length > 3) recentHistory.push({ role: 'assistant', content: aRep.slice(0, MAX_MSG_CHARS) });
    }

    // B. Hidratação de Diretrizes
    const guidelines = masterContext?.guidelines || [];
    const dynamicGuidelinesBlock = guidelines.map((g: any) => `- ${g.content}`).join('\n') || '';

    // C. Hidratação do Radar de Urgência (TDAH)
    const urgentes = masterContext?.reminders || [];
    let alertaUrgencia = '';
    if (urgentes && urgentes.length > 0) {
      alertaUrgencia = `\n[ESTADO DE ALERTA - PRIORIDADE MÁXIMA]\nCélio, atenção para pendências críticas:\n${urgentes.map((u: any) => `- ${u.title}`).join('\n')}`;
    }

    // ── 3. DEDUPLICAÇÃO GLOBAL (LOOP DE ESPERA RIGOROSO) ──────────────────────
    const timeSlot = Math.floor(Date.now() / 10000);
    const requestSignature = `${sessionId}_${Buffer.from(message.substring(0, 50)).toString('base64')}_${timeSlot}`;
    const dedupKey = `chat_dedup:${requestSignature}`;
    const replyKey = `chat_reply:${requestSignature}`;

    const isFirst = await redis.set(dedupKey, '1', { nx: true, ex: 30 });

    if (!isFirst) {
      console.warn('[Dedup] Retry detectado, aguardando cache...');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const cached = await redis.get<string>(replyKey);
        if (cached) return NextResponse.json({ reply: cached, ok: true, sessionId, performance: '0ms (dedup)' });
      }
      console.warn('[Dedup] Timeout esperando cache. Processando novamente.');
    }

    // ── 4. FASE 1: PROCESSAMENTO PARALELO (Embeddings + Contexto) ────────────
    const [queryEmbedding, isStressed, contexts] = await Promise.all([
      getCachedEmbedding(message).catch(() => null),
      llmGateway.isOverloaded(),
      classifyContextWithL4(message, String(user.id)),
    ]);

    // ── 5. FASE 2: MEMÓRIA CARREGADA ─────────────────────────────────────────
    const memory = await MemoryManager.read({
      userId: String(user.id),
      authUserId: user.auth_user_id,
      sessionId,
      message,
      contexts,
      emotionalScore: 0,
      authorName: user.nickname,
      assistantName: user.assistant_name,
      queryEmbedding,
    });

    // ── 6. FASE 3: SCORE EMOCIONAL ───────────────────────────────────────────
    const emotional = await computeEmotionalScore(
      message,
      String(user.id),
      memory.hd.memories ?? [],
      memory.ram.ramBlock ?? '',
    );

    // ── 7. CARREGAMENTO MODULAR E RADAR DE AFETO ─────────────────────────────
    const { contextBlocks, activeTools, resolvedModel } = await loadActiveModules(
      {
        userId: String(user.id),
        authUserId: user.auth_user_id,
        message,
        contexts,
        emotionalScore: emotional.score,
      },
      user.plan || 'free',
      'google/gemini-2.0-flash-001',
    );

    // Lógica Guard L3 (Meses de Alerta: Maio e Agosto)
    let filteredL3 = memory.l3.content;
    const todayCheck = new Date();
    const isHighAlertMonth = todayCheck.getMonth() === 4 || todayCheck.getMonth() === 7;

    if (recentHistory.length > 0 || isHighAlertMonth) {
      const recentText = recentHistory.map(m => m.content).join(' ');
      const historyHasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(recentText));
      const messageHasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(message));

      if (!historyHasFamilySignal && !messageHasFamilySignal && !isHighAlertMonth) {
        filteredL3 = filteredL3
          .replace(/##\s*(datas?|aniversário|comemoração|evento importante)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
          .replace(/##\s*(famil[íi]a|cônjuge|esposa|marido|filho|parente)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
          .trim();
      }
    }

    // ── 8. COMPOSIÇÃO DE PROMPT E GEO-CONSCIÊNCIA ────────────────────────────
    const nowSP = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const dataHoraSP = nowSP.toLocaleString('pt-BR');
    const dataIsoSP = nowSP.toISOString().split('T')[0];

    const basePrompt = composeSystemPrompt({
      assistantName: user.assistant_name,
      authorName: user.nickname,
      isLikelyNoise: message.length < 15,
      isSystemStressed: isStressed,
      emotionalScore: emotional.score,
      detectedContexts: contexts,
      contextBlocks,
      memoryBlocks: {
        truncatedL3: filteredL3.slice(0, 3000),
        truncatedHd: memory.hd.block.slice(0, 4000),
        truncatedEvents: memory.events.block.slice(0, 2000),
        relationship: memory.relationship.block.slice(0, 2000),
        topics: memory.topics.relatedTopicsBlock,
      },
      canonicalDateTimeBlock: dataHoraSP,
      canonicalDateISO: dataIsoSP,
      systemWarning: '',
      intent: 'personal',
      dynamicGuidelines: dynamicGuidelinesBlock,
    });

    const { contextText, activeTools: dynamicTools } = await buildDynamicContext({
      userId: String(user.id),
      authUserId: user.auth_user_id,
      message,
      location: userLocation,
      contexts: contexts || [],
      emotionalScore: emotional.score || 0
    });

    const coreTools = ['salvar_evento', 'consultar_agenda', 'create_reminder', 'searchWeb', 'buscar_memoria_longa', 'consultar_lembretes', 'adicionar_diretriz_dinamica'];
    const toolsHabilitadas = ALL_TOOLS.filter(t =>
      coreTools.includes(t.function.name) || 
      activeTools.includes(t.function.name) || 
      dynamicTools.includes(t.function.name)
    );

    const systemPrompt = `[RELÓGIO DO SISTEMA]: ${dataHoraSP}\n${contextText}${alertaUrgencia}\n---\n${basePrompt}
[DIRETRIZES DE RIGOR TÉCNICO]
1. AGENDA: Use 'salvar_evento' (Supabase) como fonte primária.
2. MENTOR: Interrompa fluxos se houver alertas de urgência (Lembretes/Agenda).
3. PROTOCOLO DE SAÍDA: Proibido responder apenas "Pronto" ou "Anotado". Descreva a ação técnica realizada no sistema. Atue como arquiteto do Expert Frotas.`;

    // ── 9. CICLO DE EXECUÇÃO LLM ─────────────────────────────────────────────
    const conversationMessages: any[] = [
      { role: 'system', content: systemPrompt },
      ...recentHistory,
      { role: 'user', content: message },
    ];

    const firstResponse = await callOpenRouterWithPriority(1, 'never', requestSignature, conversationMessages, toolsHabilitadas, resolvedModel, 0.7);

    let assistantReply: string;

    // ✅ FIX: TypeScript type narrowing para evitar erro de build
    if (firstResponse.toolCalls && firstResponse.toolCalls.length > 0) {
      console.log(`[Tools] ${firstResponse.toolCalls.length} tool(s) detectada(s)`);

      const toolResults = await Promise.all(
        firstResponse.toolCalls.map(async (toolCall) => {
          const result = await executeTool(toolCall, user.auth_user_id, String(user.id));
          return { toolCall, result };
        })
      );

      const messagesWithToolResults: any[] = [
        ...conversationMessages,
        {
          role: 'assistant',
          content: firstResponse.content || null,
          tool_calls: firstResponse.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        },
        ...toolResults.map(({ toolCall, result }) => ({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        })),
      ];

      const secondResponse = await callOpenRouterWithPriority(1, 'never', `${requestSignature}_synth`, messagesWithToolResults, [], resolvedModel, 0.7);
      assistantReply = secondResponse.content || "Comando executado com sucesso.";
    } else {
      assistantReply = firstResponse.content || "Entendido, Célio.";
    }

    // ── 10. FINALIZAÇÃO E BACKGROUND (FIRE AND FORGET) ───────────────────────
    await redis.set(replyKey, assistantReply, { ex: 30 }).catch(() => {});

    // Registro no Brain (Silencioso)
    supabase.from('brain').insert({
      user_id: Number(user.id),
      session_id: sessionId,
      content: message,
      category: message.length < 15 ? 'noise' : 'info',
      metadata: { role: 'user', ai_reply: assistantReply, contexts, model: resolvedModel },
    }).catch(e => console.error('[Brain Save Error]:', e));

    const audioBase64 = speak ? await generateTTS(assistantReply, user.preferred_voice || 'alloy') : null;

    // ✅ EXTRAÇÃO EM BACKGROUND (Desbloqueado)
    extractAndSummarize(String(user.id), user.nickname || 'Usuário', message, assistantReply)
      .catch(e => console.error('[Background Extractor Error]:', e));

    return NextResponse.json({
      reply: assistantReply,
      audioBase64,
      ok: true,
      sessionId,
      performance: `${Date.now() - startTime}ms`,
    });

  } catch (e: any) {
    console.error('[FATAL ERROR]:', e);
    return NextResponse.json({ error: 'Erro no motor do Jarvis.' }, { status: 500 });
  }
}
