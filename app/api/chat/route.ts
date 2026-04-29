// app/api/chat/route.ts — V8.15.0 (session history + L3 context guard)
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

export const maxDuration = 60;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ─── Histórico da sessão ─────────────────────────────────────────────────────
//
// Busca as últimas N mensagens da sessão para passar ao LLM como contexto
// de conversa. Sem isso, cada mensagem é tratada como a primeira.
//
// Retorna array no formato OpenAI: [{role, content}, ...]
// Ignora mensagens muito curtas (ruído) e limita o conteúdo por mensagem
// para não estourar o context window.

const MAX_HISTORY_TURNS = 6;       // pares user/assistant (6 = 3 turnos)
const MAX_MSG_CHARS     = 800;     // trunca mensagens longas no histórico

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

    // brain salva user+reply no mesmo registro; expande em dois turnos
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const row of [...data].reverse()) {
      const userMsg  = (row.content || '').trim();
      const aiReply  = (row.metadata?.ai_reply || '').trim();

      if (userMsg.length > 3) {
        turns.push({
          role:    'user',
          content: userMsg.slice(0, MAX_MSG_CHARS),
        });
      }
      if (aiReply.length > 3) {
        turns.push({
          role:    'assistant',
          content: aiReply.slice(0, MAX_MSG_CHARS),
        });
      }
    }

    // Remove o último par (é a mensagem atual, ainda não salva)
    // para não duplicar com o {role: 'user', content: message} abaixo.
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
//
// Problema: quando o usuário menciona um nome (ex: "Gisele"), o embedding
// puxa chunks de família/datas com alta similaridade, mesmo que a conversa
// seja sobre skincare. O modelo usa esses chunks como âncora e "voa".
//
// Solução: se o histórico recente já tem um tema claro de conversa
// (ex: skincare, receita, trabalho), filtra os chunks L3 para não incluir
// temas de datas/família a menos que a mensagem atual os mencione explicitamente.
//
// Temas que tendem a "sequestrar" o contexto quando não são o foco:
const ANCHOR_HIJACK_THEMES = new Set(['datas', 'familia', 'rotina']);

// Palavras que indicam que o usuário quer falar de família/datas de propósito:
const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /filh[oa]/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

function shouldFilterL3Chunk(chunkTheme: string, recentHistory: Array<{ role: string; content: string }>, currentMessage: string): boolean {
  if (!ANCHOR_HIJACK_THEMES.has(chunkTheme)) return false;

  // Se a mensagem atual menciona família/datas explicitamente, mantém o chunk
  const messageHasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(currentMessage));
  if (messageHasFamilySignal) return false;

  // Se tem histórico recente e nenhuma das últimas mensagens fala de família/datas,
  // filtra o chunk para não poluir o contexto
  if (recentHistory.length > 0) {
    const recentText = recentHistory.map(m => m.content).join(' ');
    const historyHasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(recentText));
    if (!historyHasFamilySignal) return true; // filtra
  }

  return false;
}

// ─── Handler principal ────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    const body = await (req.headers.get('content-type')?.includes('multipart')
      ? req.formData()
      : req.json());

    const message     = body instanceof FormData ? body.get('message')     as string : body.message;
    const userEmail   = body instanceof FormData ? body.get('userEmail')   as string : body.userEmail;
    const incomingSessionId = body instanceof FormData
      ? (body.get('sessionId') as string | null)
      : (body.sessionId as string | null);

    // 1. Resolve Usuário
    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!user) return NextResponse.json({ error: 'Auth failed' }, { status: 401 });

    const sessionId = incomingSessionId || await getOrCreateSession(String(user.id));

    // ── DEDUPLICAÇÃO GLOBAL ──────────────────────────────────────────────────
    const requestSignature = `${sessionId}_${Buffer.from(message.substring(0, 50)).toString('base64')}`;
    const dedupKey  = `chat_dedup:${requestSignature}`;
    const replyKey  = `chat_reply:${requestSignature}`;

    const isFirst = await redis.set(dedupKey, '1', { nx: true, ex: 30 });

    if (!isFirst) {
      console.warn('[Dedup] Retry detectado, aguardando reply cacheado...');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const cached = await redis.get<string>(replyKey);
        if (cached) {
          console.log('[Dedup] Reply cacheado encontrado, retornando.');
          return NextResponse.json({
            reply: cached,
            ok: true,
            sessionId,
            performance: '0ms (dedup)',
          });
        }
      }
      console.warn('[Dedup] Timeout esperando reply. Deixando passar.');
    }
    // ────────────────────────────────────────────────────────────────────────

    // Busca histórico e embedding em paralelo
    const [queryEmbedding, recentHistory] = await Promise.all([
      getCachedEmbedding(message).catch(() => null),
      getRecentMessages(sessionId, String(user.id)),
    ]);

    console.log(`[History] ${recentHistory.length} mensagens de histórico carregadas para sessão ${sessionId}`);

    // 2. Inteligência de Contexto
    const [isStressed, contexts, emotional] = await Promise.all([
      llmGateway.isOverloaded(),
      classifyContextWithL4(message, String(user.id)),
      computeEmotionalScore(message, String(user.id), [], ''),
    ]);

    // 3. Carregamento Modular
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

    // 4. Memória e Prompt Engine
    const memory = await MemoryManager.read({
      userId:        String(user.id),
      authUserId:    user.auth_user_id,
      sessionId,
      message,
      contexts,
      emotionalScore:  emotional.score,
      authorName:      user.nickname,
      assistantName:   user.assistant_name,
      queryEmbedding:  queryEmbedding,
    });

    // ── Guard L3: filtra chunks que podem sequestrar o contexto ──────────────
    //
    // O MemoryManager retorna o bloco L3 como string concatenada.
    // Para aplicar o filtro, precisamos inspecionar o conteúdo bruto dos chunks.
    // Estratégia: se o histórico não menciona família/datas, remove seções
    // do bloco L3 que correspondam a esses temas.
    //
    // Nota: se MemoryManager expor os chunks individualmente no futuro,
    // prefira filtrar antes do join — é mais preciso.

    let filteredL3 = memory.l3.content;

    if (recentHistory.length > 0) {
      const recentText = recentHistory.map(m => m.content).join(' ');
      const historyHasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(recentText));
      const messageHasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(message));

      if (!historyHasFamilySignal && !messageHasFamilySignal) {
        // Remove seções de datas e família do bloco L3 para não poluir o contexto
        filteredL3 = filteredL3
          .replace(/##\s*(datas?|aniversário|comemoração|evento importante)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
          .replace(/##\s*(famil[íi]a|cônjuge|esposa|marido|filho|parente)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
          .trim();

        if (filteredL3 !== memory.l3.content) {
          console.log('[L3 Guard] Chunks de família/datas filtrados — contexto da conversa não os requer.');
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // 5. Composição do Prompt e Filtragem de Ferramentas
    const coreTools = ['salvar_evento', 'create_reminder', 'searchWeb', 'buscar_memoria_longa'];
    const toolsHabilitadas = ALL_TOOLS.filter(t =>
      coreTools.includes(t.function.name) || activeTools.includes(t.function.name)
    );

    const systemPrompt = composeSystemPrompt({
      assistantName: user.assistant_name,
      authorName:    user.nickname,
      isLikelyNoise: message.length < 15,
      isSystemStressed: isStressed,
      emotionalScore:   emotional.score,
      detectedContexts: contexts,
      contextBlocks,
      memoryBlocks: {
        truncatedL3:     filteredL3.slice(0, 3000),       // usa L3 filtrado
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

    // 6. Execução via Gateway
    // ✅ FIX PRINCIPAL: inclui histórico da sessão entre system e a mensagem atual.
    // Isso dá ao modelo visibilidade do fio da conversa, evitando "viagens".
    const response = await callOpenRouterWithPriority(
      1,
      'never',
      requestSignature,
      [
        { role: 'system', content: systemPrompt },
        ...recentHistory,                          // 👈 histórico da sessão
        { role: 'user',   content: message },
      ],
      toolsHabilitadas,
      resolvedModel,
      0.7,
    );

    const assistantReply = (response as any).content || 'Processado.';

    // Cacheia o reply para o retry da Vercel recuperar
    await redis.set(replyKey, assistantReply, { ex: 30 }).catch(() => {});

    // 7. Salvamento no brain
    try {
      const cat = message.length < 15 ? 'noise' : 'info';

      await supabase.from('brain').insert({
        user_id:    Number(user.id),
        session_id: sessionId,
        content:    message,
        category:   cat,
        project_tag: 'geral',
        metadata: {
          role:     'user',
          ai_reply: assistantReply,
          contexts: contexts,
          model:    resolvedModel,
        },
      });
    } catch (dbErr) {
      console.error('[DB] Erro ao salvar no brain:', dbErr);
    }

    return NextResponse.json({
      reply: assistantReply,
      ok:    true,
      sessionId,
      performance: `${Date.now() - startTime}ms`,
    });

  } catch (e: any) {
    console.error('[FATAL]', e);
    return NextResponse.json({ error: 'Erro interno no motor.' }, { status: 500 });
  }
}
