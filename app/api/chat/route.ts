// app/api/chat/route.ts — V8.17.0 (emotional score pós-memória)
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

export const maxDuration = 60;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ─── Histórico da sessão ─────────────────────────────────────────────────────

const MAX_HISTORY_TURNS = 6;
const MAX_MSG_CHARS     = 800;

async function getRecentMessages(
  sessionId: string,
  userId: string,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  try {
    const { data } = await supabase
      .from('brain')
      .select('content, metadata, created_at')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .neq('category', 'archived')
      .order('created_at', { ascending: false })
      .limit(MAX_HISTORY_TURNS);

    if (!data || data.length === 0) return [];

    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const row of [...data].reverse()) {
      const userMsg = (row.content || '').trim();
      const aiReply = (row.metadata?.ai_reply || '').trim();

      if (userMsg.length > 3) {
        turns.push({ role: 'user', content: userMsg.slice(0, MAX_MSG_CHARS) });
      }
      if (aiReply.length > 3) {
        turns.push({ role: 'assistant', content: aiReply.slice(0, MAX_MSG_CHARS) });
      }
    }

    while (turns.length > 0 && turns[turns.length - 1].role === 'user') {
      turns.pop();
    }

    return turns;
  } catch (e) {
    console.error('[History] Erro ao buscar histórico:', e);
    return [];
  }
}

// ─── Guard de contexto L3 ────────────────────────────────────────────────────

const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /filh[oa]/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

// ─── Handler principal ────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    const body = await (req.headers.get('content-type')?.includes('multipart')
      ? req.formData()
      : req.json());

    const message           = body instanceof FormData ? body.get('message')   as string : body.message;
    const userEmail         = body instanceof FormData ? body.get('userEmail') as string : body.userEmail;
    const incomingSessionId = body instanceof FormData
      ? (body.get('sessionId') as string | null)
      : (body.sessionId as string | null);

    // 1. Resolve Usuário
    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!user) return NextResponse.json({ error: 'Auth failed' }, { status: 401 });

    const sessionId = incomingSessionId || await getOrCreateSession(String(user.id));

    // ── DEDUPLICAÇÃO GLOBAL ──────────────────────────────────────────────────
    const requestSignature = `${sessionId}_${Buffer.from(message.substring(0, 50)).toString('base64')}`;
    const dedupKey = `chat_dedup:${requestSignature}`;
    const replyKey = `chat_reply:${requestSignature}`;

    const isFirst = await redis.set(dedupKey, '1', { nx: true, ex: 30 });

    if (!isFirst) {
      console.warn('[Dedup] Retry detectado, aguardando reply cacheado...');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const cached = await redis.get<string>(replyKey);
        if (cached) {
          console.log('[Dedup] Reply cacheado encontrado, retornando.');
          return NextResponse.json({ reply: cached, ok: true, sessionId, performance: '0ms (dedup)' });
        }
      }
      console.warn('[Dedup] Timeout esperando reply. Deixando passar.');
    }
    // ────────────────────────────────────────────────────────────────────────

    // ── FASE 1: Coisas que não dependem de memória (paralelo) ────────────────
    const [queryEmbedding, recentHistory, isStressed, contexts] = await Promise.all([
      getCachedEmbedding(message).catch(() => null),
      getRecentMessages(sessionId, String(user.id)),
      llmGateway.isOverloaded(),
      classifyContextWithL4(message, String(user.id)),
    ]);

    console.log(`[History] ${recentHistory.length} mensagens de histórico carregadas para sessão ${sessionId}`);

    // ── FASE 2: Memória carregada com embedding real ──────────────────────────
    // emotionalScore=0 aqui é apenas um placeholder para o MemoryManager;
    // o score real será calculado na Fase 3 com os resultados da memória.
    const memory = await MemoryManager.read({
      userId:         String(user.id),
      authUserId:     user.auth_user_id,
      sessionId,
      message,
      contexts,
      emotionalScore: 0,
      authorName:     user.nickname,
      assistantName:  user.assistant_name,
      queryEmbedding,
    });

    // ── FASE 3: Score emocional com contexto real ─────────────────────────────
    // Agora sim temos os searchResults do HD e o bloco RAM carregados.
    const emotional = await computeEmotionalScore(
      message,
      String(user.id),
      memory.hd.memories ?? [],  // resultados brutos com similarity + emotional_weight
      memory.ram.ramBlock ?? '',         // bloco RAM real
    );

    console.log(`[EmotionalRouter] score=${emotional.score.toFixed(3)} | trajectory=${emotional.trajectory} | triggers=${emotional.triggers.join(', ') || 'nenhum'}`);

    // ── Carregamento Modular (agora com score emocional real) ─────────────────
    const { contextBlocks, activeTools, resolvedModel } = await loadActiveModules(
      {
        userId:         String(user.id),
        authUserId:     user.auth_user_id,
        message,
        contexts,
        emotionalScore: emotional.score,  // 👈 score real, não zero
      },
      user.plan || 'free',
      'google/gemini-2.0-flash-001',
    );

    // ── Guard L3 ─────────────────────────────────────────────────────────────
    let filteredL3 = memory.l3.content;

    if (recentHistory.length > 0) {
      const recentText = recentHistory.map(m => m.content).join(' ');
      const historyHasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(recentText));
      const messageHasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(message));

      if (!historyHasFamilySignal && !messageHasFamilySignal) {
        filteredL3 = filteredL3
          .replace(/##\s*(datas?|aniversário|comemoração|evento importante)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
          .replace(/##\s*(famil[íi]a|cônjuge|esposa|marido|filho|parente)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
          .trim();
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // 5. Composição do Prompt e Filtragem de Ferramentas
    const coreTools = ['salvar_evento', 'create_reminder', 'searchWeb', 'buscar_memoria_longa'];
    const toolsHabilitadas = ALL_TOOLS.filter(t =>
      coreTools.includes(t.function.name) || activeTools.includes(t.function.name)
    );

    const systemPrompt = composeSystemPrompt({
      assistantName:    user.assistant_name,
      authorName:       user.nickname,
      isLikelyNoise:    message.length < 15,
      isSystemStressed: isStressed,
      emotionalScore:   emotional.score,  // 👈 score real
      detectedContexts: contexts,
      contextBlocks,
      memoryBlocks: {
        truncatedL3:     filteredL3.slice(0, 3000),
        truncatedHd:     memory.hd.block.slice(0, 4000),
        truncatedEvents: memory.events.block.slice(0, 2000),
        relationship:    memory.relationship.block.slice(0, 2000),
        topics:          memory.topics.relatedTopicsBlock,
      },
      canonicalDateTimeBlock: new Date().toLocaleString('pt-BR'),
      canonicalDateISO:       new Date().toISOString().split('T')[0],
      systemWarning:    '',
      intent:           'personal',
      dynamicGuidelines: '',
    });

    // 6. Primeira chamada ao LLM
    const conversationMessages: any[] = [
      { role: 'system', content: systemPrompt },
      ...recentHistory,
      { role: 'user', content: message },
    ];

    const firstResponse = await callOpenRouterWithPriority(
      1, 'never', requestSignature,
      conversationMessages,
      toolsHabilitadas,
      resolvedModel,
      0.7,
    );

    let assistantReply: string;

    // 7. Loop de execução de tools
    if (firstResponse.toolCalls && firstResponse.toolCalls.length > 0) {
      console.log(`[Tools] ${firstResponse.toolCalls.length} tool(s) detectada(s):`, firstResponse.toolCalls.map(t => t.function.name));

      const toolResults = await Promise.all(
        firstResponse.toolCalls.map(async (toolCall) => {
          console.log(`[Tools] Executando: ${toolCall.function.name}`);
          const result = await executeTool(toolCall, user.auth_user_id, String(user.id));
          console.log(`[Tools] Resultado de ${toolCall.function.name}:`, result.slice(0, 100));
          return { toolCall, result };
        })
      );

      const messagesWithToolResults: any[] = [
        ...conversationMessages,
        {
          role: 'assistant',
          content: firstResponse.content || null,
          tool_calls: firstResponse.toolCalls.map(tc => ({
            id:       tc.id,
            type:     'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        },
        ...toolResults.map(({ toolCall, result }) => ({
          role:         'tool',
          tool_call_id: toolCall.id,
          content:      result,
        })),
      ];

      const secondResponse = await callOpenRouterWithPriority(
        1, 'never', `${requestSignature}_tool_synthesis`,
        messagesWithToolResults,
        [],
        resolvedModel,
        0.7,
      );

      assistantReply = secondResponse.content || 'Feito.';

    } else {
      assistantReply = firstResponse.content || 'Processado.';
    }

    await redis.set(replyKey, assistantReply, { ex: 30 }).catch(() => {});

    // 8. Salvamento no brain
    try {
      const cat = message.length < 15 ? 'noise' : 'info';

      await supabase.from('brain').insert({
        user_id:     Number(user.id),
        session_id:  sessionId,
        content:     message,
        category:    cat,
        project_tag: 'geral',
        metadata: {
          role:     'user',
          ai_reply: assistantReply,
          contexts,
          model:    resolvedModel,
        },
      });
    } catch (dbErr) {
      console.error('[DB] Erro ao salvar no brain:', dbErr);
    }

    return NextResponse.json({
      reply:       assistantReply,
      ok:          true,
      sessionId,
      performance: `${Date.now() - startTime}ms`,
    });

  } catch (e: any) {
    console.error('[FATAL]', e);
    return NextResponse.json({ error: 'Erro interno no motor.' }, { status: 500 });
  }
}