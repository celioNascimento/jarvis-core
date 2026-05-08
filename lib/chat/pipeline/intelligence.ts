// lib/chat/pipeline/intelligence.ts
// Fase 2 — Embedding, Classificação, Memória, Emoção
//
// Recebe o ChatRequestContext e devolve ChatIntelligence:
// tudo que é necessário para montar o prompt, sem saber nada
// sobre como o prompt vai ser construído.

import { supabase } from '@/lib/jarvis';
import { classifyContextWithL4, type ContextType } from '@/lib/chat/context-classifier';
import { computeEmotionalScore, type EmotionalScoreResult } from '@/lib/chat/emotional-router';
import { MemoryManager } from '@/lib/memory';
import { llmGateway } from '@/lib/chat/llm-gateway';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import type { ChatRequestContext } from './request-context';

const MAX_MSG_CHARS = 800;

// ─── Tipos exportados ─────────────────────────────────────────────────────────

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatIntelligence {
  // Contexto bruto do banco (God RPC)
  masterContext: any;

  // Histórico formatado para o LLM (alternância correta)
  recentHistory: HistoryMessage[];

  // Classificação semântica da mensagem
  contexts: ContextType[];

  // Embedding da mensagem (reutilizado por outros módulos)
  queryEmbedding: number[] | null;

  // Sistema sobrecarregado?
  isStressed: boolean;

  // Blocos de memória
  memory: Awaited<ReturnType<typeof MemoryManager.read>>;

  // Score emocional
  emotional: EmotionalScoreResult;
}

// ─── Histórico com alternância estrita ───────────────────────────────────────
// O OpenRouter exige que mensagens alternem user/assistant sem repetição.

function buildRecentHistory(rawHistory: any[]): HistoryMessage[] {
  const recentHistory: HistoryMessage[] = [];
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

  // Nunca termina com 'user' (o user atual já será adicionado pelo orquestrador)
  if (lastAddedRole === 'user') recentHistory.pop();

  return recentHistory;
}

// ─── Entrypoint público ───────────────────────────────────────────────────────

export async function runIntelligencePipeline(
  ctx: ChatRequestContext
): Promise<ChatIntelligence> {
  const { message, user, sessionId, normalizedLocation, requestSignature } = ctx;

  // 1. God RPC (contexto consolidado do banco) — roda em paralelo com geo
  const { data: masterContext, error: rpcError } = await supabase.rpc(
    'get_consolidated_context',
    { p_user_id: user.id, p_session_id: sessionId }
  );
  if (rpcError) console.error('[Intelligence] RPC error:', rpcError.message);

  // 2. Histórico formatado
  const recentHistory = buildRecentHistory(masterContext?.history || []);

  // 3. Execução paralela: embedding + classificação + status do gateway
  const [queryEmbedding, contexts, isStressed] = await Promise.all([
    getCachedEmbedding(message).catch(() => null),
    classifyContextWithL4(message, String(user.id)),
    llmGateway.isOverloaded(),
  ]);

  // 4. Memória semântica (depende do embedding e dos contextos)
  const memory = await MemoryManager.read({
    userId:        String(user.id),
    authUserId:    user.auth_user_id,
    sessionId,
    message,
    contexts,
    emotionalScore: 0,                        // será calculado abaixo
    authorName:    user.nickname,
    assistantName: user.assistant_name,
    queryEmbedding,
    masterContext,
  });

  // 5. Score emocional (depende das memórias)
  const emotional = await computeEmotionalScore(
    message,
    String(user.id),
    memory.hd.memories ?? [],
    memory.ram.ramBlock ?? ''
  );

  return {
    masterContext,
    recentHistory,
    contexts,
    queryEmbedding,
    isStressed,
    memory,
    emotional,
  };
}