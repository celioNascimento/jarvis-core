// lib/chat/pipeline/intelligence.ts
// Fase 2 — Inteligência e Contexto
// V2.1.0 — Bypass de embedding para ruído + Cache do god RPC no Redis + Type-Safe

import { supabase } from '@/lib/jarvis';
import { Redis } from '@upstash/redis';
import { classifyContextWithL4, type ContextType } from '@/lib/chat/context-classifier';
import { computeEmotionalScore, type EmotionalScoreResult } from '@/lib/chat/emotional-router';
import { MemoryManager } from '@/lib/memory';
import { llmGateway } from '@/lib/chat/llm-gateway';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import { detectAndLogCorrection } from '@/lib/tools/executors/learning';
import type { ChatRequestContext } from './request-context';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const MAX_MSG_CHARS = 800;
const MASTER_CONTEXT_TTL = 5 * 60; // 5 minutos em segundos

// ─── Detecção de ruído ────────────────────────────────────────────────────────
// Mensagens que não têm valor semântico para a memória vetorial.
// Bypass zera a chamada de embedding (~424ms) e o match_l3_chunks (~53ms).

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

/**
 * Lê o masterContext do Redis ou vai ao Supabase se expirado.
 * TTL: 5 minutos. Invalidado explicitamente por tools que escrevem dados.
 */
async function getMasterContext(userId: number, sessionId: string): Promise<any> {
  const key = masterContextKey(userId, sessionId);

  try {
    const cached = await redis.get<any>(key);
    if (cached) {
      console.info('[Intelligence] MasterContext cache hit');
      return cached;
    }
  } catch {
    // Redis falhou — cai no Supabase silenciosamente
  }

  // Cache miss — busca no Supabase
  const { data } = await supabase.rpc('get_consolidated_context', {
    p_user_id:  userId,
    p_session_id: sessionId,
  });

  const result = data || { history: [], config: {}, profile: {} };

  // Salva no Redis sem bloquear
  redis.set(key, result, { ex: MASTER_CONTEXT_TTL }).catch(() => {});

  return result;
}

/**
 * Invalida o cache do masterContext para um usuário/sessão.
 * Chamado pelo tools-executor após qualquer tool que escreva dados.
 */
export async function invalidateMasterContextCache(
  userId: number,
  sessionId: string
): Promise<void> {
  try {
    await redis.del(masterContextKey(userId, sessionId));
    console.info(`[Intelligence] MasterContext cache invalidado para user ${userId}`);
  } catch {
    // Silencioso — na pior das hipóteses o cache expira em 5 min
  }
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
  isNoise: boolean; // ← exposto para o assembler poder adaptar o prompt
}

// ─── buildRecentHistory ───────────────────────────────────────────────────────

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

// ─── Pipeline principal ───────────────────────────────────────────────────────

export async function runIntelligencePipeline(ctx: ChatRequestContext): Promise<ChatIntelligence> {
  const { message, user, sessionId } = ctx;

  const isNoise = isNoiseMessage(message);

  // 1. MasterContext — via cache Redis (economiza ~72ms em hits)
  const masterContext = await getMasterContext(user.id, sessionId);
  const safeContext = masterContext || { history: [], config: {}, profile: {} };

  // 2. Processamento paralelo
  //    - Embedding: pulado se for ruído (economiza ~477ms: embed + match_l3_chunks)
  //    - detectAndLogCorrection: roda sempre (é leve e importante)
  const [queryEmbedding, contexts, isStressed] = await Promise.all([
    isNoise
      ? Promise.resolve(null)                                          // ← BYPASS
      : getCachedEmbedding(message).catch(() => null),
    
    // CORREÇÃO: user.id numérico e safeContext injetado
    classifyContextWithL4(message, user.id, user.auth_user_id, safeContext).catch(() => []),
    
    llmGateway.isOverloaded().catch(() => false),
    
    // CORREÇÃO: safeContext injetado
    detectAndLogCorrection(message, user.id, safeContext).catch(() => {}),
  ]);

  if (isNoise) {
    console.info(`[Intelligence] Noise bypass — embedding pulado para: "${message.substring(0, 30)}"`);
  }

  // 3. Memória (blindada)
  //    Se for ruído, passa queryEmbedding=null — o MemoryManager já trata isso
  //    e pula o match_l3_chunks internamente.
  let memory: any = { hd: { memories: [] }, ram: { ramBlock: '' } };
  try {
    const memoryData = await MemoryManager.read({
      userId:        user.id, // CORREÇÃO: Removido o String(). O MemoryManager exige number.
      authUserId:    user.auth_user_id,
      sessionId,
      message,
      contexts,
      emotionalScore: 0,
      authorName:    user.nickname,
      assistantName: user.assistant_name,
      queryEmbedding,             // null para ruído — MemoryManager pula busca vetorial
      masterContext: safeContext,
    });
    if (memoryData) memory = memoryData;
  } catch (e) {
    console.error('[Intelligence] Memory bypass');
  }

  // 4. Score emocional
  const emotional = await computeEmotionalScore(
    message,
    String(user.id), // Mantido como string caso o roteador emocional espere assim internamente
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
    masterContext:  safeContext,
    recentHistory:  buildRecentHistory(safeContext.history),
    contexts,
    queryEmbedding,
    isStressed,
    memory,
    emotional,
    isNoise,
  };
}