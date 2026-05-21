// lib/chat/pipeline/intelligence.ts
// V3.0.0 — Paralelismo Absoluto, Zero-Waste & Rate-Limit Mitigation

import { supabase } from '@/lib/jarvis';
import { Redis } from '@upstash/redis';
import { classifyContextWithL4, type ContextType } from '@/lib/chat/context-classifier';
import { computeEmotionalScore, type EmotionalScoreResult } from '@/lib/chat/emotional-router';
import { llmGateway } from '@/lib/chat/llm-gateway';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import type { ChatRequestContext, LocalMessage } from './request-context';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const MAX_MSG_CHARS = 800;
const MASTER_CONTEXT_TTL = 5 * 60; // 5 minutos de cache

// ─── Detecção de Ruído ────────────────────────────────────────────────────────

const NOISE_REGEX = /^(ok|oi|olá|sim|não|nao|faz|claro|certo|blz|vlw|valeu|obrigad|show|ótimo|otimo|perfeito|legal|bom dia|boa tarde|boa noite|pode|vai|vamos|tá|ta|ok|s|n|👍|👎|😊|🤝)[!?.,:… ]*$/i;

export function isNoiseMessage(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 15) return true;
  if (NOISE_REGEX.test(trimmed)) return true;
  return false;
}

// ─── Cache do MasterContext (God RPC) ─────────────────────────────────────────

function masterContextKey(userId: number, sessionId: string): string {
  return `master_ctx:${userId}:${sessionId}`;
}

async function getMasterContext(userId: number, sessionId: string): Promise<any> {
  const key = masterContextKey(userId, sessionId);
  try {
    const cached = await redis.get<any>(key);
    if (cached) return cached;
  } catch (e) {
    console.warn('[Cache] Falha ao ler Redis, caindo para DB:', e);
  }

  const { data, error } = await supabase.rpc('get_consolidated_context', {
    p_user_id: userId,
    p_session_id: sessionId,
  });

  if (error) {
    console.error('[MasterContext] Erro fatal no RPC:', error);
  }

  const result = data || { history: [], config: {}, profile: {} };
  
  // Salva no cache sem bloquear a execução principal
  redis.set(key, result, { ex: MASTER_CONTEXT_TTL }).catch(() => { });
  return result;
}

export async function invalidateMasterContextCache(userId: number, sessionId: string): Promise<void> {
  try {
    await redis.del(masterContextKey(userId, sessionId));
  } catch { }
}

// ─── Tipos Exportados ─────────────────────────────────────────────────────────

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

// ─── RAM: Resolução de Histórico ──────────────────────────────────────────────

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
  for (const row of rawHistory) {
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

function resolveRecentHistory(localHistory: LocalMessage[], bankHistory: any[]): HistoryMessage[] {
  if (Array.isArray(bankHistory) && bankHistory.length > 0) {
    return buildRecentHistoryFromBank(bankHistory);
  }
  if (localHistory?.length > 0) {
    console.warn('[HISTORY] Fallback para localHistory');
    return buildRecentHistoryFromLocal(localHistory);
  }
  return [];
}

// ─── Pipeline Principal de Inteligência ───────────────────────────────────────

export async function runIntelligencePipeline(ctx: ChatRequestContext): Promise<ChatIntelligence> {
  const { message, user, sessionId, localHistory } = ctx;
  const isNoise = isNoiseMessage(message);

  // 1. Execução Paralela Absoluta (Max Performance)
  // Agrupamos TODAS as operações de I/O em um único Promise.all blindado contra falhas
  const [queryEmbedding, isStressed, memoryBundleRes, masterContext] = await Promise.all([
    
    // A) Embedding: Evita gasto de API se for só ruído
    isNoise 
      ? Promise.resolve(null) 
      : getCachedEmbedding(message).catch((e) => { 
          console.error('[Pipeline] Embedding fail:', e); 
          return null; 
        }),
    
    // B) Gateway Rate-Limit Check
    llmGateway.isOverloaded().catch(() => false),
    
    // C) HD Memory Bundle RPC
    supabase.rpc('get_full_memory_bundle', { p_user_id: user.id })
      .catch((e) => { 
        console.error('[Pipeline] Memory bundle fail:', e); 
        return { data: null }; 
      }),
      
    // D) MasterContext (God RPC + Cache)
    getMasterContext(user.id, sessionId)
      .catch((e) => {
        console.error('[Pipeline] MasterContext fail:', e);
        return { history: [], config: {}, profile: {} };
      })
  ]);

  // 2. Garante a estrutura da memória mesmo se o RPC falhar
  const memory = memoryBundleRes?.data || {
    hd: { memories: [] },
    ram: { ramBlock: '' },
    l3: { chunks: [] },
    events: [],
    topics: []
  };

  // 3. Classificação de Contexto (Depende do MasterContext)
  const contexts = await classifyContextWithL4(
    message,
    user.id,
    user.auth_user_id,
    masterContext
  ).catch((e) => {
    console.error('[Pipeline] Classification fail:', e);
    return [];
  });

  // 4. Cálculo de Score Emocional
  const emotional = await computeEmotionalScore(
    message,
    String(user.id),
    memory.hd?.memories || [],
    memory.ram?.ramBlock || ''
  ).catch((e): EmotionalScoreResult => {
    console.error('[Pipeline] Emotional score fail:', e);
    return {
      score: 0,
      trajectory: 'stable',
      primaryEmotion: 'neutral',
      triggers: [],
      memoryScore: 0,
      personScore: 0,
      moodAdjustment: 0,
      escalatingCount: 0
    };
  });

  // 5. Resolução do Histórico (SSOT: Prioridade Banco -> Fallback Local)
  const recentHistory = resolveRecentHistory(localHistory, masterContext.history);

  return {
    masterContext,
    recentHistory,
    contexts,
    queryEmbedding,
    isStressed,
    memory,
    emotional,
    isNoise,
  };
}
