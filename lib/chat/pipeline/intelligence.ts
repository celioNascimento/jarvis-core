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

export async function runIntelligencePipeline(ctx: ChatRequestContext): Promise<ChatIntelligence> {
  const { message, user, sessionId } = ctx;

  // 1. God RPC
  const { data: masterContext, error: rpcError } = await supabase.rpc(
    'get_consolidated_context',
    { p_user_id: user.id, p_session_id: sessionId }
  );
  if (rpcError) console.error('[Intelligence] RPC error:', rpcError.message);
  
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

  // 4. Memória semântica
  let memory: any = { hd: { memories: [] }, ram: { ramBlock: '' } };
  try {
    const memoryData = await MemoryManager.read({
      userId: String(user.id),
      authUserId: user.auth_user_id,
      sessionId,
      message,
      contexts,
      emotionalScore: 0,
      authorName: user.nickname,
      assistantName: user.assistant_name,
      queryEmbedding,
      masterContext: safeMasterContext,
    });
    if (memoryData) memory = memoryData;
  } catch (e) { console.error('[Intelligence] Memory crash:', e); }

  // 5. Score emocional (Apenas propriedades conhecidas da interface)
  const emotional = await computeEmotionalScore(
    message,
    String(user.id),
    memory?.hd?.memories || [],
    memory?.ram?.ramBlock || ''
  ).catch((): EmotionalScoreResult => ({
    score: 0,
    analysis: 'Fallback de emergência',
    needsEscalation: false,
    primaryEmotion: 'neutral',
    secondaryEmotion: 'neutral',
    trajectory: 'stable',
    triggers: [],
    memoryScore: 0,
    personScore: 0
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
