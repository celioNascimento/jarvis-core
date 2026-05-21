// lib/chat/pipeline/intelligence.ts
// Versão Definitiva (Complete & Full-Verbose)
// Inclui Reconciliação de Histórico, Pipeline de Memória, Log de Segurança e Lazy Loading

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
const MASTER_CONTEXT_TTL = 3 * 60; // 3 minutos

// ─── Interfaces ─────────────────────────────────────────────────────────────

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

// ─── Utils & Detectores ─────────────────────────────────────────────────────

const NOISE_REGEX = /^(ok|oi|olá|sim|não|nao|faz|claro|certo|blz|vlw|valeu|obrigad|show|ótimo|otimo|perfeito|legal|bom dia|boa tarde|boa noite|pode|vai|vamos|tá|ta|ok|s|n|👍|👎|😊|🤝)[!?.,:… ]*$/i;

export function isNoiseMessage(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 15) return true;
  return NOISE_REGEX.test(trimmed);
}

// ─── Cache do MasterContext ─────────────────────────────────────────────────

function masterContextKey(userId: number, sessionId: string): string {
  return `master_ctx:${userId}:${sessionId}`;
}

async function getMasterContext(userId: number, sessionId: string, contexts: string[] = []): Promise<any> {
  const key = masterContextKey(userId, sessionId);
  
  try {
    const cached = await redis.get<any>(key);
    if (cached) {
      console.log(`[Cache] Hit para user ${userId}`);
      return cached;
    }
  } catch (e) {
    console.error('[Cache] Erro de conexão Redis:', e);
  }

  console.log(`[MasterContext] Fetching DB (Tags: ${contexts.join(', ')})`);
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
  redis.set(key, result, { ex: MASTER_CONTEXT_TTL }).catch(e => console.error('[Cache] Erro ao salvar:', e));
  return result;
}

// ─── Reconciliação de Histórico (Detalhamento Completo) ──────────────────────

function buildRecentHistoryFromLocal(localHistory: LocalMessage[]): HistoryMessage[] {
  console.log('[History] Processando via localHistory');
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
    // Validação rígida para evitar conteúdo corrompido
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
  // Fallback seguro
  if (localHistory?.length > 0) {
    console.warn('[HISTORY] Fallback para localHistory ativado');
    return buildRecentHistoryFromLocal(localHistory);
  }
  return [];
}

// ─── Pipeline Principal ─────────────────────────────────────────────────────

export async function runIntelligencePipeline(ctx: ChatRequestContext): Promise<ChatIntelligence> {
  const { message, user, sessionId, localHistory } = ctx;
  const isNoise = isNoiseMessage(message);

  // 1. Context Tagging - Otimização de Lazy Loading
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
  console.log('[Pipeline] Iniciando execução paralela');
  
  const [queryEmbedding, isStressed, memoryBundleRes, masterContext] = await Promise.all([
    isNoise ? Promise.resolve(null) : getCachedEmbedding(message).catch((e) => {
      console.error('[Pipeline] Embedding Error:', e);
      return null;
    }),
    
    llmGateway.isOverloaded().catch(() => false),
    
    supabase.rpc('get_full_memory_bundle', { p_user_id: user.id })
      .then(res => ({ data: res.data }))
      .catch((e) => {
        console.error('[Pipeline] Memory Bundle Error:', e);
        return { data: null };
      }),
      
    getMasterContext(user.id, sessionId, contextTags)
  ]);

  // 3. Resolução de Memória & Contexto
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
    console.error('[Pipeline] Classificação de contexto falhou:', e);
    return [];
  });

  // 4. Score Emocional
  const emotional = await computeEmotionalScore(
    message, 
    String(user.id), 
    memory.hd?.memories || [], 
    memory.ram?.ramBlock || ''
  ).catch((e) => {
    console.error('[Pipeline] Emotional score falhou:', e);
    return { 
      score: 0, trajectory: 'stable', primaryEmotion: 'neutral', triggers: [], 
      memoryScore: 0, personScore: 0, moodAdjustment: 0, escalatingCount: 0 
    };
  });

  // 5. Histórico final
  const recentHistory = resolveRecentHistory(localHistory, masterContext.history || []);

  console.log(`[Pipeline] Concluído para user ${user.id}. IsNoise: ${isNoise}`);

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
