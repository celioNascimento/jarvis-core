// lib/chat/pipeline/intelligence.ts
// Fase 2 — Inteligência e Contexto (Blindado e Tipado para Number)

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
  return recentHistory;
}

export async function runIntelligencePipeline(ctx: ChatRequestContext): Promise<ChatIntelligence> {
  const { message, user, sessionId } = ctx;

  // 1. Contexto Consolidado (A ÚNICA chamada de banco que deve existir aqui)
  const { data: masterContext } = await supabase.rpc('get_consolidated_context', {
    p_user_id: user.id,
    p_session_id: sessionId
  });
  
  const safeContext = masterContext || { history: [], config: {}, profile: {} };

  // 2. Processamento Paralelo
  const [queryEmbedding, contexts, isStressed] = await Promise.all([
    getCachedEmbedding(message).catch(() => null),
    
    // Passando o ID numérico, o authUserId (UUID) e o safeContext injetado
    classifyContextWithL4(message, user.id, user.auth_user_id, safeContext).catch(() => []),
    
    llmGateway.isOverloaded().catch(() => false),
    
    // Passando o safeContext injetado
    detectAndLogCorrection(message, user.id, safeContext).catch(() => {}),
  ]);

  // 3. Memória (Blindada)
  let memory: any = { hd: { memories: [] }, ram: { ramBlock: '' } };
  try {
    const memoryData = await MemoryManager.read({
      userId: user.id, // ✅ CORREÇÃO: Passando o number bruto, sem String()
      authUserId: user.auth_user_id,
      sessionId,
      message,
      contexts,
      emotionalScore: 0,
      authorName: user.nickname,
      assistantName: user.assistant_name,
      queryEmbedding,
      masterContext: safeContext,
    });
    if (memoryData) memory = memoryData;
  } catch (e) { console.error('[Intelligence] Memory bypass'); }

  // 4. Score Emocional (O "Cast de Ouro" restaurado para evitar o erro do Turbopack)
  const emotional = await computeEmotionalScore(
    message,
    String(user.id), // Mantido como string se o roteador emocional exigir
    memory?.hd?.memories || [],
    memory?.ram?.ramBlock || ''
  ).catch(() => ({
    score: 0,
    primaryEmotion: 'neutral',
    secondaryEmotion: 'neutral',
    trajectory: 'stable',
    triggers: [],
    needsEscalation: false,
    memoryScore: 0,
    personScore: 0,
    moodAdjustment: 0,
    escalatingCount: 0
  } as unknown as EmotionalScoreResult));

  return {
    masterContext: safeContext,
    recentHistory: buildRecentHistory(safeContext.history),
    contexts,
    queryEmbedding,
    isStressed,
    memory,
    emotional,
  };
}
