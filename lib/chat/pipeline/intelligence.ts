// lib/chat/pipeline/intelligence.ts
// Versão Integral: Padrão de Produção - Reconciliação, Auditoria e Performance Lazy-Loading

import { supabase } from '@/lib/jarvis';
import { Redis } from '@upstash/redis';
import { classifyContextWithL4, type ContextType } from '@/lib/chat/context-classifier';
import { computeEmotionalScore, type EmotionalScoreResult } from '@/lib/chat/emotional-router';
import { llmGateway } from '@/lib/chat/llm-gateway';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import type { ChatRequestContext, LocalMessage } from './request-context';

// ─── Configurações e Constantes de Auditoria ───────────────────────────────

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const MAX_MSG_CHARS = 800;
const MASTER_CONTEXT_TTL = 3 * 60; // 3 minutos

// Padrão de ruído para economia de processamento (Noise Detection)
const NOISE_REGEX = /^(ok|oi|olá|sim|não|nao|faz|claro|certo|blz|vlw|valeu|obrigad|show|ótimo|otimo|perfeito|legal|bom dia|boa tarde|boa noite|pode|vai|vamos|tá|ta|ok|s|n|👍|👎|😊|🤝)[!?.,:… ]*$/i;

// ─── Interfaces Críticas ───────────────────────────────────────────────────

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

// ─── Helpers de Diagnóstico e Auditoria ────────────────────────────────────

/**
 * Verifica se a mensagem é apenas ruído, evitando chamadas desnecessárias de API
 */
export function isNoiseMessage(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 15) return true;
  return NOISE_REGEX.test(trimmed);
}

function masterContextKey(userId: number, sessionId: string): string {
  return `master_ctx:${userId}:${sessionId}`;
}

// ─── Cache & RPC Logic (Versão Completa com Lazy Loading) ──────────────────

/**
 * Busca o MasterContext do banco com carregamento seletivo via tags
 */

async function getMasterContext(userId: number, sessionId: string, contexts: string[] = []): Promise<any> {
  const key = masterContextKey(userId, sessionId);
  
  try {
    const cached = await redis.get<any>(key);
    if (cached) return cached;
  } catch (e) {
    console.warn('[Cache] Falha Redis:', e);
  }

  const { data, error } = await supabase.rpc('get_consolidated_context', {
    p_user_id: userId,
    p_session_id: sessionId,
    p_contexts: contexts 
  });

  if (error) {
    console.error('[MasterContext] Erro fatal no RPC:', error);
    return { history: [], config: {}, profile: {} };
  }

  const result = data || {};

  // --- CRÍTICO: Sanitização para evitar estouro de limite do Redis ---
  // Se o objeto 'config' tiver embeddings, removemos antes de salvar
  if (result.config && typeof result.config === 'object') {
    Object.keys(result.config).forEach(k => {
      if (k.startsWith('embedding_')) {
        delete result.config[k];
      }
    });
  }

  // Só salva se o tamanho for razoável (apenas um check extra de segurança)
  const stringified = JSON.stringify(result);
  if (stringified.length < 5 * 1024 * 1024) { // 5MB limite seguro
    redis.set(key, result, { ex: MASTER_CONTEXT_TTL }).catch(() => { });
  } else {
    console.warn('[Cache] Objeto muito grande, não salvo no Redis');
  }
  
  return result;
}

/**
 * Invalida o cache do MasterContext para forçar atualização
 */
export async function invalidateMasterContextCache(userId: number, sessionId: string): Promise<void> {
  try {
    const key = masterContextKey(userId, sessionId);
    await redis.del(key);
    console.log(`[Cache][Invalidate] Cache removido com sucesso para session ${sessionId}`);
  } catch (e) {
    console.error('[Cache][Error] Falha ao invalidar cache no Redis:', e);
  }
}

// ─── Reconciliação de Histórico (Detalhamento Completo - SSOT) ───────────────

function buildRecentHistoryFromLocal(localHistory: LocalMessage[]): HistoryMessage[] {
  console.log('[History][Reconcile] Construindo histórico via localHistory (fallback)');
  return localHistory
    .slice(-30)
    .map(msg => ({
      role: msg.role,
      content: msg.content.slice(0, MAX_MSG_CHARS),
    }));
}

function buildRecentHistoryFromBank(rawHistory: any[]): HistoryMessage[] {
  if (!Array.isArray(rawHistory)) {
    console.warn('[History][Reconcile] rawHistory não é um array válido, retornando vazio');
    return [];
  }
  
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
  // SSOT: Prioridade para o banco
  if (Array.isArray(bankHistory) && bankHistory.length > 0) {
    return buildRecentHistoryFromBank(bankHistory);
  }
  // Fallback para histórico local
  if (localHistory?.length > 0) {
    return buildRecentHistoryFromLocal(localHistory);
  }
  return [];
}

// ─── Pipeline Principal (A Orquestração) ────────────────────────────────────

export async function runIntelligencePipeline(ctx: ChatRequestContext): Promise<ChatIntelligence> {
  const { message, user, sessionId, localHistory } = ctx;
  const isNoise = isNoiseMessage(message);

  console.log(`[Pipeline] Orquestração iniciada: ${message.slice(0, 50)}...`);

  // 1. Context Tagging - Otimização para Lazy Loading no SQL
  const contextTags: string[] = [];
  const m = message.toLowerCase();
  
  if (m.includes('carro') || m.includes('frota') || m.includes('abastecimento') || m.includes('manuten')) {
    contextTags.push('veiculos');
  }
  if (m.includes('projeto') || m.includes('tarefa') || m.includes('desenvolvimento')) {
    contextTags.push('projeto');
  }
  if (m.includes('dinheiro') || m.includes('gasto') || m.includes('pagamento') || m.includes('orç')) {
    contextTags.push('financas');
  }

  // 2. Execução Paralela Absoluta
  console.log('[Pipeline] Iniciando execução paralela das tarefas');

  const [queryEmbedding, isStressed, memoryBundleRes, masterContext] = await Promise.all([
    isNoise ? Promise.resolve(null) : getCachedEmbedding(message).catch((e) => {
      console.error('[Pipeline][Embedding] Falha na busca de embedding:', e);
      return null;
    }),
    
    llmGateway.isOverloaded().catch(() => false),
    
    // Tratamento tipado da Promise para evitar erros de build
    (async () => {
      try {
        const res = await supabase.rpc('get_full_memory_bundle', { p_user_id: user.id });
        return { data: res.data };
      } catch (e) {
        console.error('[Pipeline][MemoryBundle] Falha ao buscar bundle:', e);
        return { data: null };
      }
    })(),
      
    getMasterContext(user.id, sessionId, contextTags)
  ]);

  // 3. Resolução de Memória e Contexto L4
  const memory = memoryBundleRes?.data || { 
    hd: { memories: [] }, 
    ram: { ramBlock: '' },
    l3: { chunks: [] },
    events: [],
    topics: []
  };
  
  const contexts = await classifyContextWithL4(
    message, 
    user.id, 
    user.auth_user_id, 
    masterContext
  ).catch((e) => {
    console.error('[Pipeline][Classification] Erro na classificação L4:', e);
    return [];
  });

  // 4. Score Emocional (Analítico)
  const emotional = await computeEmotionalScore(
    message, 
    String(user.id), 
    memory.hd?.memories || [], 
    memory.ram?.ramBlock || ''
  ).catch((e) => {
    console.error('[Pipeline][Emotional] Erro na análise emocional:', e);
    return { 
      score: 0, trajectory: 'stable', primaryEmotion: 'neutral', triggers: [], 
      memoryScore: 0, personScore: 0, moodAdjustment: 0, escalatingCount: 0 
    };
  });

  // 5. Histórico final (Reconciliação SSOT)
  const recentHistory = resolveRecentHistory(localHistory, masterContext.history || []);

  console.log('[Pipeline] Orquestração finalizada com sucesso');

  return {
    masterContext,
    recentHistory,
    contexts,
    queryEmbedding,
    isStressed,
    memory,
    emotional,
    isNoise
  };
}
