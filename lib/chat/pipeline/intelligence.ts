// lib/chat/pipeline/intelligence.ts
// Fase 2 — Inteligência e Contexto
// V2.2.0 — localHistory do frontend como fonte primária de RAM

import { supabase } from '@/lib/jarvis';
import { Redis } from '@upstash/redis';
import { classifyContextWithL4, type ContextType } from '@/lib/chat/context-classifier';
import { computeEmotionalScore, type EmotionalScoreResult } from '@/lib/chat/emotional-router';
import { MemoryManager } from '@/lib/memory';
import { llmGateway } from '@/lib/chat/llm-gateway';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import { detectAndLogCorrection } from '@/lib/tools/executors/learning';
import type { ChatRequestContext, LocalMessage } from './request-context';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const MAX_MSG_CHARS = 800;
const MASTER_CONTEXT_TTL = 5 * 60;

// ─── Detecção de ruído ────────────────────────────────────────────────────────

const NOISE_REGEX = /^(ok|oi|olá|sim|não|nao|faz|claro|certo|blz|vlw|valeu|obrigad|show|ótimo|otimo|perfeito|legal|bom dia|boa tarde|boa noite|pode|vai|vamos|tá|ta|ok|s|n|👍|👎|😊|🤝)[!?.,:… ]*$/i;

export function isNoiseMessage(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 15) return true;
  if (NOISE_REGEX.test(trimmed)) return true;
  return false;
}

// ─── Cache do MasterContext ───────────────────────────────────────────────────

function masterContextKey(userId: number, sessionId: string): string {
  return `master_ctx:${userId}:${sessionId}`;
}

async function getMasterContext(userId: number, sessionId: string): Promise<any> {
  const key = masterContextKey(userId, sessionId);
  try {
    const cached = await redis.get<any>(key);
    if (cached) return cached;
  } catch {}

  const { data } = await supabase.rpc('get_consolidated_context', {
    p_user_id:    userId,
    p_session_id: sessionId,
  });

  const result = data || { history: [], config: {}, profile: {} };
  redis.set(key, result, { ex: MASTER_CONTEXT_TTL }).catch(() => {});
  return result;
}

export async function invalidateMasterContextCache(userId: number, sessionId: string): Promise<void> {
  try {
    await redis.del(masterContextKey(userId, sessionId));
  } catch {}
}

// ─── Tipos exportados ─────────────────────────────────────────────────────────

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
  isNoise: boolean;
}

// ─── RAM: fonte primária = localHistory, fallback = banco ────────────────────

function buildRecentHistoryFromLocal(localHistory: LocalMessage[]): HistoryMessage[] {
  return localHistory
    .slice(-30)
    .map(msg => ({
      role: msg.role,
      content: msg.content.slice(0, MAX_MSG_CHARS),
    }));
}

function buildRecentHistoryFromBank(rawHistory: any[]): HistoryMessage[] {
  if (!Array.isArray(rawHistory)) return [];

  const history: HistoryMessage[] = [];

  for (const row of [...rawHistory].reverse()) {
    const uMsg = (row.content || '').trim();
    const aRep = (row.metadata?.ai_reply || '').trim();

    if (uMsg.length > 2) {
      history.push({ role: 'user', content: uMsg.slice(0, MAX_MSG_CHARS) });
    }
    if (aRep.length > 2) {
      history.push({ role: 'assistant', content: aRep.slice(0, MAX_MSG_CHARS) });
    }
  }

  return history.slice(-20);
}

function resolveRecentHistory(
  localHistory: LocalMessage[],
  bankHistory: any[]
): HistoryMessage[] {
  if (localHistory?.length > 0) {
    return buildRecentHistoryFromLocal(localHistory);
  }
  return buildRecentHistoryFromBank(bankHistory);
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

export async function runIntelligencePipeline(ctx: ChatRequestContext): Promise<ChatIntelligence> {
  const { message, user, sessionId, localHistory } = ctx;
  const isNoise = isNoiseMessage(message);

  // 1. MasterContext (Cache-First)
  const masterContext = await getMasterContext(user.id, sessionId);
  const safeContext = masterContext || { history: [], config: {}, profile: {} };

  // 2. Processamento paralelo
  const [queryEmbedding, contexts, isStressed] = await Promise.all([
    isNoise
      ? Promise.resolve(null)
      : getCachedEmbedding(message).catch(() => null),

    classifyContextWithL4(message, user.id, user.auth_user_id, safeContext).catch(() => []),

    llmGateway.isOverloaded().catch(() => false),

    detectAndLogCorrection(message, user.id, safeContext).catch(() => {}),
  ]);

  // 3. Memória (L3 + HD — RAM vem do localHistory agora)
  let memory: any = {
    hd:           { memories: [] },
    ram:          { ramBlock: '' },
    l3:           { content: '' },
    events:       { block: '' },
    relationship: { block: '' },
    topics:       { relatedTopicsBlock: '' },
  };

  try {
    const memoryData = await MemoryManager.read({
      userId:        user.id,
      authUserId:    user.auth_user_id,
      sessionId,
      message,
      contexts,
      emotionalScore: 0,
      authorName:    user.nickname,
      assistantName: user.assistant_name,
      queryEmbedding,
      masterContext: safeContext,
    });
    if (memoryData) memory = memoryData;
  } catch {
    console.error('[Intelligence] Memory error bypass');
  }

  // 4. Score Emocional
  const emotional = await computeEmotionalScore(
    message,
    String(user.id),
    memory?.hd?.memories || [],
    memory?.ram?.ramBlock || ''
  ).catch(() => ({
    score: 0,
    primaryEmotion: 'neutral',
    trajectory: 'stable',
  } as unknown as EmotionalScoreResult));

  // 5. RAM: localHistory tem prioridade sobre o banco
  const recentHistory = resolveRecentHistory(localHistory, safeContext.history);

  return {
    masterContext: safeContext,
    recentHistory,
    contexts,
    queryEmbedding,
    isStressed,
    memory,
    emotional,
    isNoise,
  };
}
