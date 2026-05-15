// lib/chat/pipeline/intelligence.ts
// Fase 2 — Inteligência e Contexto
// V2.1.1 — Reforço de Contexto Imediato + Cache Redis + Bypasses

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
const MASTER_CONTEXT_TTL = 5 * 60; // 5 minutos

// ─── Detecção de ruído (Mantido rigorosamente) ──────────────────────────────
const NOISE_REGEX = /^(ok|oi|olá|sim|não|nao|faz|claro|certo|blz|vlw|valeu|obrigad|show|ótimo|otimo|perfeito|legal|bom dia|boa tarde|boa noite|pode|vai|vamos|tá|ta|ok|s|n|👍|👎|😊|🤝)[!?.,:… ]*$/i;

export function isNoiseMessage(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 15) return true;
  if (NOISE_REGEX.test(trimmed)) return true;
  return false;
}

// ─── Cache do MasterContext (Mantido rigorosamente) ───────────────────────────
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
    p_user_id:  userId,
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

// ─── buildRecentHistory (RECONSTRUÍDA COM ANCORAGEM DE CONTEXTO) ──────────────
function buildRecentHistory(rawHistory: any[]): HistoryMessage[] {
  if (!Array.isArray(rawHistory)) return [];
  
  // O consolidated_context traz o histórico. Precisamos garantir que
  // a ordem seja cronológica para o LLM entender a linha do tempo.
  const history: HistoryMessage[] = [];
  let lastAddedRole: string | null = null;

  // Processamos do mais antigo para o mais novo
  const processedRows = [...rawHistory].reverse();
  const totalRows = processedRows.length;

  processedRows.forEach((row, index) => {
    const uMsg = (row.content || '').trim();
    const aRep = (row.metadata?.ai_reply || '').trim();

    // Regra de Ouro: As últimas 3 mensagens do usuário recebem um marcador de ancoragem
    // Isso evita que o modelo ignore o fato de que o assunto mudou para "Davi" agora.
    const isVeryRecent = (totalRows - index) <= 3;
    const anchor = isVeryRecent ? "📍 [CONTEXTO ATUAL]: " : "";

    if (uMsg.length > 2 && lastAddedRole !== 'user') {
      history.push({ 
        role: 'user', 
        content: anchor + uMsg.slice(0, MAX_MSG_CHARS) 
      });
      lastAddedRole = 'user';
    }
    
    if (aRep.length > 2 && lastAddedRole !== 'assistant') {
      history.push({ 
        role: 'assistant', 
        content: aRep.slice(0, MAX_MSG_CHARS) 
      });
      lastAddedRole = 'assistant';
    }
  });

  return history;
}

// ─── Pipeline principal (Mantido com melhorias de tipagem) ─────────────────────
export async function runIntelligencePipeline(ctx: ChatRequestContext): Promise<ChatIntelligence> {
  const { message, user, sessionId } = ctx;
  const isNoise = isNoiseMessage(message);

  // 1. MasterContext (Cache-First)
  const masterContext = await getMasterContext(user.id, sessionId);
  const safeContext = masterContext || { history: [], config: {}, profile: {} };

  // 2. Processamento paralelo com Bypass inteligente
  const [queryEmbedding, contexts, isStressed] = await Promise.all([
    isNoise
      ? Promise.resolve(null)
      : getCachedEmbedding(message).catch(() => null),
    
    classifyContextWithL4(message, user.id, user.auth_user_id, safeContext).catch(() => []),
    
    llmGateway.isOverloaded().catch(() => false),
    
    // Detector de correções (Ex: "Não é o Miguel, é o Davi")
    detectAndLogCorrection(message, user.id, safeContext).catch(() => {}),
  ]);

  // 3. Gestão de Memória (RAM + HD)
  let memory: any = { hd: { memories: [] }, ram: { ramBlock: '' }, l3: { content: '' }, events: { block: '' }, relationship: { block: '' }, topics: { relatedTopicsBlock: '' } };
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
      queryEmbedding, // Se for null (noise), o MemoryManager pula a busca vetorial
      masterContext: safeContext,
    });
    if (memoryData) memory = memoryData;
  } catch (e) {
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
    trajectory: 'stable'
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
