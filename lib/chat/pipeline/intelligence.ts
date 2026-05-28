// lib/chat/pipeline/intelligence.ts
// V16.0 - Integração de Memories ao MasterContext

import { supabase } from '@/lib/jarvis';
import { classifyContextWithL4, type ContextType } from '@/lib/chat/context-classifier';
import { computeEmotionalScore, type EmotionalScoreResult } from '@/lib/chat/emotional-router';
import { llmGateway } from '@/lib/chat/llm-gateway';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import type { ChatRequestContext, LocalMessage } from './request-context';
import { ContextCache, invalidateSessionHistory } from '@/lib/services/context-cache';
import { reinforceMemory } from '@/lib/services/memory.service';
import { loadMemoriesForContext, type MemoriesLoadResult, type MemoryRecord } from '@/lib/data/memories.data';

const MAX_MSG_CHARS = 800;

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
  emotional: EmotionalScoreResult;
  isNoise: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function isNoiseMessage(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 15) return true;
  return NOISE_REGEX.test(trimmed);
}

// ─── Cache & RPC Logic ──────────────────────────────────────────────────────

const CACHED_FIELDS = ['settings', 'modules', 'guidelines', 'persons', 'locations', 'shopping', 'reminders', 'children', 'profile'] as const;

async function getMasterContext(
  userId: number,
  sessionId: string,
  contexts: string[] = []
): Promise<any> {
  const cache = new ContextCache(userId);

  const cached = await cache.getMany([...CACHED_FIELDS]);
  const cachedHistory = await cache.getHistory(sessionId);

  const missingFields = CACHED_FIELDS.filter(f => !(f in cached));
  const needsHistory = !cachedHistory || cachedHistory.length === 0;

  console.log('[MasterContext] Cache status:', {
    hit: CACHED_FIELDS.filter(f => f in cached),
    miss: missingFields,
    historyHit: !needsHistory,
  });

  if (missingFields.length === 0 && !needsHistory) {
    console.log('[MasterContext] Cache hit total — Zero queries ao Supabase.');
    return { ...cached, history: cachedHistory };
  }

  console.log('[MasterContext] Cache miss — rodando RPC consolidado e histórico');

  const [rpcRes, historyRes] = await Promise.allSettled([
    supabase.rpc('get_consolidated_context', {
      p_user_id:    userId,
      p_session_id: sessionId,
      p_contexts:   contexts,
    }),
    needsHistory
      ? supabase.rpc('get_session_history', {
          p_user_id:    userId,
          p_session_id: sessionId,
        })
      : Promise.resolve({ data: cachedHistory }),
  ]);

  const result      = rpcRes.status === 'fulfilled' && rpcRes.value.data ? rpcRes.value.data : {};
  const historyData = historyRes.status === 'fulfilled' && historyRes.value?.data
    ? historyRes.value.data
    : cachedHistory || [];

  result.shopping = {
    items:  result.shopping_items  || [],
    shares: result.shopping_shares || [],
  };

  const savePromises: Promise<void>[] = [];

  if (needsHistory) {
    savePromises.push(cache.setHistory(sessionId, historyData));
  }

  for (const f of missingFields) {
    const value = result[f];
    if (value == null) continue;

    if (f === 'persons' && Array.isArray(value)) {
      const slim = value.map((p: any) => ({
        id: p.id, name: p.name, type: p.type, nickname: p.nickname, emotional_weight: p.emotional_weight,
      }));
      savePromises.push(cache.set(f, slim));
      continue;
    }

    savePromises.push(cache.set(f, value));
  }

  Promise.all(savePromises).catch(e => console.error('[MasterContext] Erro salvando cache:', e));

  return { ...cached, ...result, history: historyData };
}

export async function invalidateMasterContextCache(
  userId: number,
  sessionId: string
): Promise<void> {
  await invalidateSessionHistory(userId, sessionId);
  console.log(`[ContextCache] History invalidado para session ${sessionId}`);
}

// ─── Reconciliação de Histórico ──────────────────────────────────────────────

function buildRecentHistoryFromLocal(localHistory: LocalMessage[]): HistoryMessage[] {
  console.log('[History][Reconcile] Construindo histórico via localHistory (fallback)');
  return localHistory
    .slice(-30)
    .map(msg => ({ role: msg.role, content: msg.content.slice(0, MAX_MSG_CHARS) }));
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
    if (uMsg.length > 2) history.push({ role: 'user',      content: uMsg.slice(0, MAX_MSG_CHARS) });
    if (aRep.length > 2) history.push({ role: 'assistant', content: aRep.slice(0, MAX_MSG_CHARS) });
  }
  return history.slice(-20);
}

function resolveRecentHistory(localHistory: LocalMessage[], bankHistory: any[]): HistoryMessage[] {
  if (Array.isArray(bankHistory) && bankHistory.length > 0) return buildRecentHistoryFromBank(bankHistory);
  if (localHistory?.length > 0) return buildRecentHistoryFromLocal(localHistory);
  return [];
}

// ─── Pipeline Principal ──────────────────────────────────────────────────────

export async function runIntelligencePipeline(ctx: ChatRequestContext): Promise<ChatIntelligence> {
  const { message, user, sessionId, localHistory } = ctx;
  const isNoise = isNoiseMessage(message);

  console.log(`[Pipeline] Orquestração iniciada: ${message.slice(0, 50)}...`);

  const contextTags: string[] = [];
  const m = message.toLowerCase();
  if (m.includes('carro')    || m.includes('frota')  || m.includes('abastecimento') || m.includes('manuten')) contextTags.push('veiculos');
  if (m.includes('projeto')  || m.includes('tarefa') || m.includes('desenvolvimento'))                         contextTags.push('projeto');
  if (m.includes('dinheiro') || m.includes('gasto')  || m.includes('pagamento')     || m.includes('orç'))     contextTags.push('financas');

  const shouldEmbed        = false;
  const shouldLoadMemories = !isNoise;

  console.log(`[Pipeline] Execução paralela. Embedding: ${shouldEmbed ? 'ATIVO' : 'SKIP'} | Memories: ${shouldLoadMemories ? 'ATIVO' : 'SKIP'}`);

  // ── Tuple tipado explicitamente para o TS não colapsar em any[] ───────────
  type PipelineTuple = [number[] | null, boolean, any, MemoriesLoadResult];

  const EMPTY_MEMORIES: MemoriesLoadResult = { memories: [], topEmotional: [] };

  const pipelineResult = await Promise.race([
    Promise.all([
      shouldEmbed
        ? getCachedEmbedding(message).catch((e) => { console.error('[Pipeline][Embedding] Falha:', e); return null; })
        : Promise.resolve(null as number[] | null),
      llmGateway.isOverloaded().catch((): boolean => false),
      getMasterContext(user.id, sessionId, contextTags),
      shouldLoadMemories
        ? loadMemoriesForContext(user.id, message, 5, 0.3)
        : Promise.resolve(EMPTY_MEMORIES),
    ] as const),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT_SEGURANCA')), 8000)
    ),
  ]).catch((err): PipelineTuple => {
    if (err.message === 'TIMEOUT_SEGURANCA') {
      console.error('[Pipeline][Fatal] Timeout (8s). Retornando contexto parcial.');
      return [null, false, { history: [], config: {}, profile: {} }, EMPTY_MEMORIES];
    }
    throw err;
  });

  const [queryEmbedding, isStressed, masterContext, memoriesResult] = pipelineResult as PipelineTuple;

  // Injeta memories no masterContext — dados fluem para baixo, nunca sobem
  masterContext.memories             = memoriesResult.memories;
  masterContext.topEmotionalMemories = memoriesResult.topEmotional;

  // Reforça as top 3 memórias carregadas (fire-and-forget, não bloqueia o request)
  if (memoriesResult.memories.length > 0) {
    Promise.allSettled(
      memoriesResult.memories
        .slice(0, 3)
        .map((mem: MemoryRecord) => reinforceMemory(mem.id, user.id))
    ).catch(console.error);
  }

  // Classificação L4
  const contexts = await classifyContextWithL4(message, user.id, user.auth_user_id, masterContext)
    .catch((e) => { console.error('[Pipeline][Classification] Erro:', e); return []; });

  // Análise Emocional
  const emotional = await computeEmotionalScore(
    message,
    String(user.id),
    masterContext?.history || [],
    masterContext?.user?.current_context || ''
  ).catch(() => ({
    score: 0, trajectory: 'stable', primaryEmotion: 'neutral', triggers: [],
    memoryScore: 0, personScore: 0, moodAdjustment: 0, escalatingCount: 0,
  }));

  const recentHistory = resolveRecentHistory(localHistory, masterContext?.history || []);

  console.log('[Pipeline] Orquestração finalizada com sucesso');

  return {
    masterContext,
    recentHistory,
    contexts,
    queryEmbedding,
    isStressed,
    emotional,
    isNoise,
  };
}
