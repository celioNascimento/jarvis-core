// lib/chat/pipeline/intelligence.ts
// V18.0 — Knowledge Base integrada: busca conhecimento curado por domínio
//          em paralelo com memórias pessoais

import { supabase } from '@/lib/jarvis';
import { classifyContextWithL4, type ContextType } from '@/lib/chat/context-classifier';
import { computeEmotionalScore, type EmotionalScoreResult } from '@/lib/chat/emotional-router';
import { llmGateway } from '@/lib/chat/llm-gateway';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import type { ChatRequestContext, LocalMessage } from './request-context';
import { ContextCache, invalidateSessionHistory } from '@/lib/services/context-cache';
import { reinforceMemory } from '@/lib/services/memory.service';
import { loadMemoriesForContext, type MemoriesLoadResult, type MemoryRecord } from '@/lib/data/memories.data';
import { loadKnowledgeForDomain, detectKnowledgeDomain, type KnowledgeLoadResult } from '@/lib/data/knowledge.data';
import { decrypt } from '@/lib/crypto-utils';

const MAX_MSG_CHARS = 800;

// Padrão de ruído para economia de processamento (Noise Detection)
const NOISE_REGEX = /^(ok|oi|olá|sim|não|nao|faz|claro|certo|blz|vlw|valeu|obrigad|show|ótimo|otimo|perfeito|legal|bom dia|boa tarde|boa noite|pode|vai|vamos|tá|ta|ok|s|n|👍|👎|😊|🤝)[!?.,:… ]*$/i;

// Detecta perguntas explícitas de memória/retrospecto
const MEMORY_QUERY_REGEX = /\b(lembra|lembrar|falamos|comentei|disse que|você sabe que|contei|mencionei|te falei|a gente conversou|aquela vez|antes você|já te falei)\b/i;

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

// Campos-base: o RPC os devolve SEMPRE, então podem ser servidos do cache.
// (insights e related_topics também são base no RPC, mas antes ficavam de fora do cache e
//  sumiam do prompt em todo acerto de cache.)
const CACHED_FIELDS = [
  'settings', 'modules', 'guidelines', 'persons', 'locations', 'shopping', 'reminders',
  'children', 'profile', 'insights', 'related_topics',
] as const;

// jsonb_agg devolve NULL quando não há linhas. Sem isto o campo nunca era gravado no cache
// (`value == null → continue`) e o usuário sem, por ex., lembretes pendentes ou filhos ficava em
// "cache miss" para sempre, rodando o RPC inteiro a cada mensagem. [] conta como acerto.
const EMPTY_FIELD_DEFAULTS: Partial<Record<(typeof CACHED_FIELDS)[number], any>> = {
  settings: [], modules: [], guidelines: [], persons: [], locations: [], reminders: [],
  children: [], insights: [], related_topics: [],
};

// Campos que o RPC (jarvis.get_consolidated_context) só devolve conforme as tags de contexto da
// mensagem. Não são cacheados (dependem da mensagem e mudam rápido); em acerto de cache precisam
// ser buscados, senão os módulos de agenda, rotinas, projetos etc. enxergam listas vazias.
const CONTEXT_TAG_FIELDS: Record<string, string[]> = {
  agenda:   ['events', 'calendar_block'],
  evento:   ['events', 'calendar_block'],
  rotina:   ['routines'],
  foco:     ['routines'],
  financas: ['budgets'],
  projeto:  ['projects'],
  veiculos: ['vehicles', 'vehicle_maintenances', 'vehicle_refuels'],
  diario:   ['diary'],
};

async function fetchContextualFields(
  userId: number,
  sessionId: string,
  contexts: string[],
): Promise<Record<string, any>> {
  const wanted = new Set<string>();
  for (const tag of contexts) (CONTEXT_TAG_FIELDS[tag] || []).forEach((f) => wanted.add(f));
  if (wanted.size === 0) return {};

  try {
    const { data, error } = await supabase.rpc('get_consolidated_context', {
      p_user_id: userId,
      p_session_id: sessionId,
      p_contexts: contexts,
    });
    if (error || !data) {
      console.warn('[MasterContext] Falha ao buscar campos contextuais:', error?.message);
      return {};
    }
    const picked: Record<string, any> = {};
    wanted.forEach((f) => { if (data[f] != null) picked[f] = data[f]; });
    console.log('[MasterContext] Campos contextuais buscados:', Object.keys(picked));
    return picked;
  } catch (e) {
    console.warn('[MasterContext] Erro ao buscar campos contextuais:', e);
    return {};
  }
}

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
    // Acerto total nos campos-base. Só consulta o banco se a mensagem pede campos contextuais
    // (agenda, rotina, projeto...); nas demais continua sem nenhuma query.
    const contextual = await fetchContextualFields(userId, sessionId, contexts);
    console.log(
      Object.keys(contextual).length
        ? '[MasterContext] Cache hit nos campos-base + campos contextuais do RPC.'
        : '[MasterContext] Cache hit total — Zero queries ao Supabase.',
    );
    return { ...cached, ...contextual, history: cachedHistory };
  }

  console.log('[MasterContext] Cache miss — rodando RPC consolidado e histórico');

  const [rpcRes, historyRes] = await Promise.allSettled([
    supabase.rpc('get_consolidated_context', {
      p_user_id: userId,
      p_session_id: sessionId,
      p_contexts: contexts,
    }),
    needsHistory
      ? supabase.rpc('get_session_history', {
        p_user_id: userId,
        p_session_id: sessionId,
      })
      : Promise.resolve({ data: cachedHistory }),
  ]);

  const result = rpcRes.status === 'fulfilled' && rpcRes.value.data ? rpcRes.value.data : {};
  const historyData = historyRes.status === 'fulfilled' && historyRes.value?.data
    ? historyRes.value.data
    : cachedHistory || [];

  result.shopping = {
    items: result.shopping_items || [],
    shares: result.shopping_shares || [],
  };

  const savePromises: Promise<void>[] = [];

  if (needsHistory) {
    savePromises.push(cache.setHistory(sessionId, historyData));
  }

  for (const f of missingFields) {
    const value = result[f] ?? EMPTY_FIELD_DEFAULTS[f];
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
  console.log('[History][Reconcile] Construindo histórico via localHistory');
  return localHistory
    .filter(msg =>
      (msg?.role === 'user' || msg?.role === 'assistant') &&
      typeof msg.content === 'string' &&
      msg.content.trim().length > 0,
    )
    .slice(-30)
    .map(msg => ({ role: msg.role, content: msg.content.trim().slice(0, MAX_MSG_CHARS) }));
}

function safeDecrypt(value: string): string {
  if (!value) return value;

  const parts = value.split(':');
  if (parts.length !== 3) return value;

  const [iv, authTag, ciphertext] = parts;
  if (iv.length !== 24 || authTag.length !== 32 || ciphertext.length === 0) return value;

  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

function buildRecentHistoryFromBank(rawHistory: any[]): HistoryMessage[] {
  if (!Array.isArray(rawHistory)) {
    console.warn('[History][Reconcile] rawHistory não é um array válido, retornando vazio');
    return [];
  }

  const history: HistoryMessage[] = [];
  for (const row of rawHistory) {
    const uMsg = safeDecrypt(row.content || '').trim();
    const aRep = safeDecrypt(row.metadata?.ai_reply || '').trim();

    if (uMsg.length > 2) history.push({ role: 'user', content: uMsg.slice(0, MAX_MSG_CHARS) });
    if (aRep.length > 2) history.push({ role: 'assistant', content: aRep.slice(0, MAX_MSG_CHARS) });
  }
  return history.slice(-20);
}

function resolveRecentHistory(localHistory: LocalMessage[], bankHistory: any[]): HistoryMessage[] {
  const persisted = Array.isArray(bankHistory) ? buildRecentHistoryFromBank(bankHistory) : [];
  const local = Array.isArray(localHistory) ? buildRecentHistoryFromLocal(localHistory) : [];

  if (persisted.length === 0) return local;
  if (local.length === 0) return persisted;

  // O banco pode estar atrasado quando a mensagem anterior ainda está sendo
  // persistida. Mantemos os dois históricos e removemos apenas duplicatas
  // exatas, evitando que uma nova pergunta fique sem o turno imediatamente anterior.
  const merged = [...persisted];
  for (const message of local) {
    const duplicate = merged.some(
      existing => existing.role === message.role && existing.content === message.content,
    );
    if (!duplicate) merged.push(message);
  }

  const result = merged.slice(-30);
  console.log('[History][Reconcile] histórico persistido/local reconciliado', {
    persisted: persisted.length,
    local: local.length,
    result: result.length,
  });
  return result;
}

// ─── Pipeline Principal ──────────────────────────────────────────────────────

export async function runIntelligencePipeline(ctx: ChatRequestContext): Promise<ChatIntelligence> {
  const { message, user, sessionId, localHistory } = ctx;
  const isNoise = isNoiseMessage(message);

  // Detecta se é uma pergunta de memória explícita
  const isMemoryQuery = MEMORY_QUERY_REGEX.test(message);

  // Detecta se a mensagem pertence a um domínio de conhecimento curado
  const knowledgeDomain = detectKnowledgeDomain(message);
  console.log(`[Knowledge] domain="${knowledgeDomain}" | msg="${message.substring(0, 80)}"`)
  const shouldLoadKnowledge = !!knowledgeDomain;

  console.log(`[Pipeline] Orquestração iniciada: ${message.slice(0, 50)}...`);
  console.log(`[Pipeline] isMemoryQuery: ${isMemoryQuery} | isNoise: ${isNoise} | knowledgeDomain: ${knowledgeDomain ?? 'nenhum'}`);

  const contextTags: string[] = [];
  const m = message.toLowerCase();
  if (m.includes('carro') || m.includes('frota') || m.includes('abastecimento') || m.includes('manuten')) contextTags.push('veiculos');
  if (m.includes('projeto') || m.includes('tarefa') || m.includes('desenvolvimento')) contextTags.push('projeto');
  if (m.includes('dinheiro') || m.includes('gasto') || m.includes('pagamento') || m.includes('orç')) contextTags.push('financas');

  const shouldEmbed = isMemoryQuery || (!isNoise && message.trim().length > 30);
  const shouldLoadMemories = isMemoryQuery || !isNoise;

  console.log(`[Pipeline] Execução paralela. Embedding: ${shouldEmbed ? 'ATIVO' : 'SKIP'} | Memories: ${shouldLoadMemories ? 'ATIVO' : 'SKIP'} | Knowledge: ${shouldLoadKnowledge ? 'ATIVO' : 'SKIP'}`);

  type PipelineTuple = [number[] | null, boolean, any, MemoriesLoadResult, KnowledgeLoadResult];

  const EMPTY_MEMORIES: MemoriesLoadResult = { memories: [], topEmotional: [] };
  const EMPTY_KNOWLEDGE: KnowledgeLoadResult = { records: [], domain: '' };

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
      shouldLoadKnowledge
        ? loadKnowledgeForDomain(knowledgeDomain!, message, 2).catch((e) => {
            console.error('[Pipeline][Knowledge] Falha:', e);
            return EMPTY_KNOWLEDGE;
          })
        : Promise.resolve(EMPTY_KNOWLEDGE),
    ] as const),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT_SEGURANCA')), 8000)
    ),
  ]).catch((err): PipelineTuple => {
    if (err.message === 'TIMEOUT_SEGURANCA') {
      console.error('[Pipeline][Fatal] Timeout (8s). Retornando contexto parcial.');
      return [null, false, { history: [], config: {}, profile: {} }, EMPTY_MEMORIES, EMPTY_KNOWLEDGE];
    }
    throw err;
  });

  const [queryEmbedding, isStressed, masterContext, memoriesResult, knowledgeResult] = pipelineResult as PipelineTuple;

  masterContext.memories = memoriesResult.memories;
  masterContext.topEmotionalMemories = memoriesResult.topEmotional;
  masterContext.knowledge = knowledgeResult.records; // conhecimento curado por domínio

  if (knowledgeResult.records.length > 0) {
    console.log(`[Pipeline] Knowledge: ${knowledgeResult.records.length} registros de '${knowledgeDomain}' injetados no contexto`);
  }

  // Reforça as top 3 memórias carregadas (fire-and-forget)
  if (memoriesResult.memories.length > 0) {
    Promise.allSettled(
      memoriesResult.memories
        .slice(0, 3)
        .map((mem: MemoryRecord) =>
          reinforceMemory(user.id, String(mem.id))
        )
    ).catch(console.error);
  }

  // Classificação L4 — passa a mensagem para que retrospecto seja detectado
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
