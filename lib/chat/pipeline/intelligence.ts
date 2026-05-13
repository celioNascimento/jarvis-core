// lib/chat/pipeline/intelligence.ts
// Fase 2 — Embedding, Classificação, Memória, Emoção

import { supabase } from '@/lib/jarvis';
import { classifyContextWithL4, type ContextType } from '@/lib/chat/context-classifier';
import { computeEmotionalScore, type EmotionalScoreResult } from '@/lib/chat/emotional-router';
import { MemoryManager } from '@/lib/memory';
import { llmGateway } from '@/lib/chat/llm-gateway';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import { detectAndLogCorrection } from '@/lib/tools/executors/learning';
import type { ChatRequestContext } from './request-context';

const MAX_MSG_CHARS = 800;

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatIntelligence {
  masterContext: any;
  recentHistory: HistoryMessage[];
  contexts: ContextType[];
  queryEmbedding: number[] | null;
  isStressed: boolean;
  memory: any;
  emotional: EmotionalScoreResult;
}

function buildRecentHistory(rawHistory: any[]): HistoryMessage[] {
  if (!Array.isArray(rawHistory)) return [];
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
  if (lastAddedRole === 'user') recentHistory.pop();
  return recentHistory;
}

export async function runIntelligencePipeline(
  ctx: ChatRequestContext
): Promise<ChatIntelligence> {
  const { message, user, sessionId } = ctx;

  // 1. God RPC (Blindagem contra Null)
  const { data: masterContext, error: rpcError } = await supabase.rpc(
    'get_consolidated_context',
    { p_user_id: user.id, p_session_id: sessionId }
  );
  if (rpcError) console.error('[Intelligence] RPC error:', rpcError.message);
  
  // Garantimos que masterContext seja ao menos um objeto vazio para não quebrar a memória
  const safeMasterContext = masterContext || { history: [], config: {}, profile: {} };

  // 2. Histórico
  const recentHistory = buildRecentHistory(safeMasterContext.history);

  // 3. Execução paralela
  const [queryEmbedding, contexts, isStressed] = await Promise.all([
    getCachedEmbedding(message).catch(() => null),
    classifyContextWithL4(message, String(user.id)).catch(() => [] as ContextType[]),
    llmGateway.isOverloaded().catch(() => false),
    detectAndLogCorrection(message, user.id).catch(() => {}),
  ]);

  // 4. Memória semântica com Try/Catch para evitar Panic
  let memory: any = { hd: { memories: [] }, ram: { ramBlock: '' } };
  try {
    const memoryData = await MemoryManager.read({
      userId:        String(user.id),
      authUserId:    user.auth_user_id,
      sessionId,
      message,
      contexts,
      emotionalScore: 0,
      authorName:    user.nickname,
      assistantName: user.assistant_name,
      queryEmbedding,
      masterContext: safeMasterContext,
    });
    if (memoryData) memory = memoryData;
  } catch (memError) {
    console.error('[Intelligence] Memory Manager crash prevented:', memError);
  }

  // 5. Score emocional (Acesso seguro a propriedades)
  const memoriesForEmotional = memory?.hd?.memories || [];
  const ramForEmotional = memory?.ram?.ramBlock || '';

  const emotional = await computeEmotionalScore(
    message,
    String(user.id),
    memoriesForEmotional,
    ramForEmotional
  ).catch((e) => ({
    score: 0,
    label: 'neutral',
    analysis: 'Fallback devido a erro no processamento',
    needsEscalation: false
  }));

  return {
    masterContext: safeMasterContext,
    recentHistory,
    contexts,
    queryEmbedding,
    isStressed,
    memory,
    emotional,
  };
}
