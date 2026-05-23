// lib/chat/pipeline/intelligence.ts
// V15.0 - Remoção de RPC Zumbi e Correção do Loop de Shopping (Regra 3)

import { supabase } from '@/lib/jarvis';
import { classifyContextWithL4, type ContextType } from '@/lib/chat/context-classifier';
import { computeEmotionalScore, type EmotionalScoreResult } from '@/lib/chat/emotional-router';
import { llmGateway } from '@/lib/chat/llm-gateway';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import type { ChatRequestContext, LocalMessage } from './request-context';
import { ContextCache, invalidateSessionHistory } from '@/lib/services/context-cache';

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

const STATIC_FIELDS = ['settings', 'modules', 'guidelines', 'persons', 'locations', 'shopping'] as const;

async function getMasterContext(
  userId: number,
  sessionId: string,
  contexts: string[] = []
): Promise<any> {
  const cache = new ContextCache(userId);

  // 1. Busca campos estáticos do Redis em paralelo (uma roundtrip via mget)
  const cached = await cache.getMany([...STATIC_FIELDS]);

  // 2. Identifica quais campos estáticos estão ausentes no cache
  const missingStatic = STATIC_FIELDS.filter(f => !(f in cached));

  console.log('[MasterContext] Cache status:', {
    hit: STATIC_FIELDS.filter(f => f in cached),
    miss: missingStatic,
    modulesType: cached.modules
      ? `array[${Array.isArray(cached.modules) ? cached.modules.length : 'não-array'}]`
      : 'ausente',
  });

  // 3. Cache hit total — busca só histórico e reminders
  if (missingStatic.length === 0) {
    console.log('[MasterContext] Cache hit total — buscando apenas history e reminders');

    const [historyRes, remindersRes] = await Promise.allSettled([
      supabase.rpc('get_session_history', {
        p_user_id: userId,
        p_session_id: sessionId,
      }),
      supabase
        .schema('jarvis')
        .from('reminders')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'pending')
        .limit(10),
    ]);

    const historyData = historyRes.status === 'fulfilled' ? historyRes.value.data : null;
    const remindersData = remindersRes.status === 'fulfilled' ? remindersRes.value.data : null;

    if (remindersData) {
      cache.set('reminders', remindersData).catch(() => { });
    }

    return {
      ...cached,
      history: historyData || [],
      reminders: remindersData || cached.reminders || [],
    };
  }

  // 4. Cache miss parcial ou total — roda o RPC completo
  console.log(`[MasterContext] Cache miss em: ${missingStatic.join(', ')} — rodando RPC`);

  const { data, error } = await supabase.rpc('get_consolidated_context', {
    p_user_id: userId,
    p_session_id: sessionId,
    p_contexts: contexts,
  });

  if (error) {
    console.error('[MasterContext] Erro fatal no RPC:', error);
    return { history: [], ...cached };
  }

  const result = data || {};

  // CORREÇÃO: Unificando o shopping antes de salvar (Resolve o Loop do Cache)
  result.shopping = {
    items: result.shopping_items || [],
    shares: result.shopping_shares || []
  };

  console.log('[MasterContext] RPC retornou:', {
    fields: Object.keys(result),
    modulesCount: Array.isArray(result.modules) ? result.modules.length : 'não-array',
    modulesSample: Array.isArray(result.modules) ? result.modules.slice(0, 2) : result.modules,
  });

  // 5. Popula o cache
  const savePromises: Promise<void>[] = [];

  for (const f of missingStatic) {
    const value = result[f];

    if (value == null) {
      console.warn(`[MasterContext] Campo '${f}' veio nulo do RPC — não cacheado`);
      continue;
    }

    if (f === 'modules' && !Array.isArray(value)) {
      console.warn('[MasterContext] modules não é array — não cacheado:', value);
      continue;
    }

    if (f === 'persons' && Array.isArray(value)) {
      const slim = value.map((p: any) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        nickname: p.nickname,
        emotional_weight: p.emotional_weight,
      }));
      console.log(`[MasterContext] Salvando persons slim — ${slim.length} registros`);
      savePromises.push(cache.set(f, slim));
      continue;
    }

    console.log(`[MasterContext] Salvando '${f}'`);
    savePromises.push(cache.set(f, value));
  }

  await Promise.all(savePromises);

  return result;
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
  if (Array.isArray(bankHistory) && bankHistory.length > 0) {
    return buildRecentHistoryFromBank(bankHistory);
  }
  if (localHistory?.length > 0) {
    return buildRecentHistoryFromLocal(localHistory);
  }
  return [];
}

// ─── Pipeline Principal ──────────────────────────────────────────────────────

export async function runIntelligencePipeline(ctx: ChatRequestContext): Promise<ChatIntelligence> {
  const { message, user, sessionId, localHistory } = ctx;
  const isNoise = isNoiseMessage(message);

  console.log(`[Pipeline] Orquestração iniciada: ${message.slice(0, 50)}...`);

  // Identificação de tags de contexto (Fluxo Downstream)
  const contextTags: string[] = [];
  const m = message.toLowerCase();
  if (m.includes('carro') || m.includes('frota') || m.includes('abastecimento') || m.includes('manuten')) contextTags.push('veiculos');
  if (m.includes('projeto') || m.includes('tarefa') || m.includes('desenvolvimento')) contextTags.push('projeto');
  if (m.includes('dinheiro') || m.includes('gasto') || m.includes('pagamento') || m.includes('orç')) contextTags.push('financas');

  // Filtro inteligente: Embedding apenas se necessário (Regra de Eficiência)
  const shouldEmbed = false;

  console.log(`[Pipeline] Execução paralela. Embedding: ${shouldEmbed ? 'ATIVO' : 'SKIP'}`);

  const [queryEmbedding, isStressed, masterContext] = await Promise.race([
    Promise.all([
      shouldEmbed
        ? getCachedEmbedding(message).catch((e) => { console.error('[Pipeline][Embedding] Falha:', e); return null; })
        : Promise.resolve(null),
      llmGateway.isOverloaded().catch(() => false),
      getMasterContext(user.id, sessionId, contextTags),
    ]),
    new Promise<any[]>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT_SEGURANCA')), 8000)
    ),
  ]).catch((err) => {
    if (err.message === 'TIMEOUT_SEGURANCA') {
      console.error('[Pipeline][Fatal] Timeout (8s). Retornando contexto parcial.');
      return [null, false, { history: [], config: {}, profile: {} }];
    }
    throw err;
  });

  // Classificação L4 (sempre segura via masterContext)
  const contexts = await classifyContextWithL4(message, user.id, user.auth_user_id, masterContext)
    .catch((e) => { console.error('[Pipeline][Classification] Erro:', e); return []; });

  // Análise Emocional (Regra de Dados Downstream)
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

