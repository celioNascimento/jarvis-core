// lib/memory/index.ts
// Memory Manager — Fonte única de verdade para todas as camadas de memória do Lev
// V1.0.0 — Bloco 1: Tipos e interfaces

import { supabase } from '@/lib/jarvis';
import { compressToSummary, semanticRamCompression, RAM_MAX_CHARS } from '@/lib/chat/ram';
import { detectTopicShiftWithL4 } from '@/lib/chat/context-classifier';

import { getRelatedTopics } from '@/lib/chat/topic-index';
import { buildRecommendationsBlock, buildTopicBlock } from '@/lib/extractor-jobs';
import { planContextualBlocks } from '@/lib/chat/context-classifier';
import { generateEmbedding } from '@/lib/jarvis';
import { indexL3Chunks } from '@/lib/chat/l3-chunks';


// ─── Camadas de memória ───────────────────────────────────────────────────────

export type MemoryLayer =
  | 'ram'           // histórico da sessão atual (brain)
  | 'l3'            // dossiê do usuário (l3_chunks + current_context)
  | 'hd'            // memórias semânticas de longo prazo (memories)
  | 'ashes'         // memórias distantes consolidadas (memory_ashes)
  | 'events'        // eventos e datas (events)
  | 'topics'        // padrões recorrentes (topic_index)
  | 'recommendations' // recomendações (recommendations)
  | 'relationship'; // memórias e eventos do relacionamento

// ─── Tipos de escrita ─────────────────────────────────────────────────────────

export type MemoryWriteType =
  | 'conversation'    // salva no brain
  | 'fact'            // salva no HD como fato sobre o usuário
  | 'recommendation'  // salva em recommendations + HD
  | 'event'           // salva em events
  | 'diary'           // salva em diary_entries
  | 'goal'            // salva em goals
  | 'profile'         // salva em user_profiles
  | 'l3_patch'        // atualiza current_context + reindexar l3_chunks
  | 'relationship_memory'  // salva em relationship_memories
  | 'relationship_event';  // salva em relationship_events

// ─── Resultado de leitura por camada ─────────────────────────────────────────

export interface RAMResult {
  recentPairs: Array<{ role: 'user' | 'assistant'; content: string }>;
  ramBlock: string;
  sessionId: string;
}

export interface L3Result {
  content: string;         // chunks relevantes concatenados
  themes: string[];        // temas dos chunks retornados
  isFallback: boolean;     // true se usou current_context direto
}

export interface HDResult {
  memories: Array<{
    id: string;
    summary: string;
    similarity: number;
    emotional_weight: number;
  }>;
  block: string;           // texto concatenado para o prompt
  memoryIds: string[];     // IDs para reinforceMemory
}

export interface AshesResult {
  block: string;           // texto concatenado para o prompt
  periods: Array<{
    summary: string;
    period_start: string;
    period_end: string;
  }>;
}

export interface EventsResult {
  upcoming: any[];         // próximos 7 dias
  important: any[];        // relevance_score >= 0.7
  block: string;           // texto formatado para o prompt
}

export interface TopicsResult {
  topicBlock: string;
  recommendationsBlock: string;
  relatedTopicsBlock: string;
}

export interface RelationshipResult {
  hasData: boolean;
  block: string;           // texto formatado para o prompt
  sharedMemories: Array<{
    summary: string;
    similarity?: number;
  }>;
  sharedEvents: Array<{
    title: string;
    event_date: string;
    emotional_weight: number;
  }>;
  hiddenItems: Array<{    // itens ocultos do usuário atual (presentes, surpresas)
    resource: string;
    reveal_at: string;
    note: string | null;
  }>;
}

// ─── Resultado agregado completo ──────────────────────────────────────────────

export interface MemoryReadResult {
  ram:            RAMResult;
  l3:             L3Result;
  hd:             HDResult;
  ashes:          AshesResult;
  events:         EventsResult;
  topics:         TopicsResult;
  relationship:   RelationshipResult;

  // Metadados da leitura — úteis para logging e debug
  meta: {
    userId: string;
    sessionId: string;
    layersLoaded: MemoryLayer[];
    layersSkipped: MemoryLayer[];
    durationMs: number;
  };
}

// ─── Payload de escrita ───────────────────────────────────────────────────────

export interface MemoryWritePayload {
  type: MemoryWriteType;
  userId: string;
  authUserId?: string;
  relationshipId?: string;  // obrigatório para relationship_memory e relationship_event

  // Campos de conteúdo — usados conforme o type
  summary?: string;
  embedding?: number[];
  emotionalWeight?: number;
  category?: string;

  // Para events e relationship_events
  title?: string;
  eventDate?: string;
  isRecurring?: boolean;
  notes?: string;

  // Para conversation (brain)
  sessionId?: string;
  messageText?: string;
  aiReply?: string;
  metadata?: Record<string, any>;

  // Para l3_patch
  dossie?: string;

  // Para profile
  profileData?: Record<string, any>;
}

// ─── Opções de leitura ────────────────────────────────────────────────────────

export interface MemoryReadOptions {
  userId: string;
  authUserId: string;
  sessionId: string;
  queryEmbedding: number[] | null;
  contexts: string[];
  message: string;
  emotionalScore: number;
  authorName: string;

  // Quais camadas carregar — se omitido, usa planContextualBlocks
  layers?: Partial<Record<MemoryLayer, boolean>>;
}

// ─── Bloco 2: Leitor de RAM ───────────────────────────────────────────────────
// Cole após o Bloco 1 no arquivo lib/memory/index.ts
//
// Responsabilidade: lê o histórico da sessão atual do brain,
// detecta shift de tópico e monta recentPairs + ramBlock para o prompt.

const ASSISTANT_REPLY_MAX = 300;

function trimAssistantReply(reply: string, maxChars = ASSISTANT_REPLY_MAX): string {
  if (!reply) return '';
  const cleaned = reply.replace(/\[.*?\]/g, '').trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) + '…' : cleaned;
}

export async function readRAM(
  userId: string,
  sessionId: string,
  contexts: string[],
  messageText: string,
  authorName: string,
  assistantName: string,
  queryEmbedding: number[] | null,
  hdBlock: string,
): Promise<RAMResult> {
  try {
    const { data: historySession } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('user_id', userId)
      .eq('session_id', sessionId)
      .neq('category', 'archived')
      .order('created_at', { ascending: false })
      .limit(6);

    let ramBlock = '';
    let recentPairs: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    const hasEnoughHistory = historySession && historySession.length >= 2;
    const shiftDetected = hasEnoughHistory
      ? await detectTopicShiftWithL4(userId, contexts as any[])
      : false;

    if (hasEnoughHistory) {
      const pairsToUse = shiftDetected
        ? historySession.slice(0, 1)
        : historySession.slice(0, 4);

      recentPairs = [...pairsToUse].reverse().flatMap((h: any) => [
        { role: 'user' as const, content: h.content },
        { role: 'assistant' as const, content: trimAssistantReply(h.metadata?.ai_reply || '') },
      ]);

      if (shiftDetected && historySession.length > 1) {
        const validHistory = historySession.filter((h: any) => h.metadata?.ai_reply);
        if (validHistory.length > 1) {
          ramBlock = `[CONTEXTO ANTERIOR RESUMIDO]\n${compressToSummary(validHistory.slice(1))}`;
        }
      }
    } else {
      if (historySession && historySession.length > 0) {
        ramBlock = [...historySession].reverse().map(
          (h: any) => `${authorName}: ${h.content}\n${assistantName}: ${trimAssistantReply(h.metadata?.ai_reply || '')}`
        ).join('\n\n');
      } else {
        const semanticBlock = await semanticRamCompression(
          historySession || [],
          userId,
          messageText,
          queryEmbedding ?? undefined,
        );
        ramBlock = semanticBlock || (hdBlock ? `[Contexto anterior consolidado]\n${hdBlock}` : ' ');
      }

      if (ramBlock.length > RAM_MAX_CHARS) {
        ramBlock = ramBlock.slice(-RAM_MAX_CHARS);
      }
    }

    return { recentPairs, ramBlock, sessionId };

  } catch (e) {
    console.error('[MemoryManager/RAM] Erro:', e);
    return { recentPairs: [], ramBlock: '', sessionId };
  }
}

// ─── Bloco 3: Leitor de L3 ───────────────────────────────────────────────────
// Cole após o Bloco 2 no arquivo lib/memory/index.ts
//
// Responsabilidade: lê os chunks semânticos do dossiê (l3_chunks)
// relevantes para a mensagem atual. Fallback para current_context
// se não houver chunks indexados ou a busca falhar.

export async function readL3(
  userId: string,
  queryEmbedding: number[] | null,
  threshold = 0.3,
  maxChunks = 3,
): Promise<L3Result> {
  try {
    // Sem embedding disponível — usa current_context direto
    if (!queryEmbedding) {
      const { data } = await supabase
        .from('users')
        .select('current_context')
        .eq('id', userId)
        .maybeSingle();

      return {
        content: data?.current_context || '',
        themes: [],
        isFallback: true,
      };
    }

    // Tenta busca semântica nos chunks
    const { data: results, error } = await supabase.rpc('match_l3_chunks', {
      query_embedding: queryEmbedding,
      p_user_id:       Number(userId),
      match_threshold: threshold,
      match_count:     maxChunks,
    });

    if (error) {
      console.error('[MemoryManager/L3] Erro na busca semântica:', error.message);
      return await l3Fallback(userId);
    }

    // Sem match acima do threshold — tenta top-2 sem threshold
    if (!results || results.length === 0) {
      const { data: topResults } = await supabase.rpc('match_l3_chunks_top', {
        query_embedding: queryEmbedding,
        p_user_id:       Number(userId),
        match_count:     2,
      });

      if (!topResults?.length) return await l3Fallback(userId);

      const themes = topResults.map((r: any) => r.theme);
      console.log(`[MemoryManager/L3] Fallback top-2: ${themes.join(', ')}`);

      return {
        content: topResults.map((r: any) => r.content).join('\n\n'),
        themes,
        isFallback: false,
      };
    }

    const themes = results.map((r: any) => `${r.theme}(${r.similarity?.toFixed(2)})`);
    console.log(`[MemoryManager/L3] Match semântico: ${themes.join(', ')}`);

    return {
      content: results.map((r: any) => r.content).join('\n\n'),
      themes: results.map((r: any) => r.theme),
      isFallback: false,
    };

  } catch (e) {
    console.error('[MemoryManager/L3] Exceção:', e);
    return await l3Fallback(userId);
  }
}

async function l3Fallback(userId: string): Promise<L3Result> {
  try {
    const { data } = await supabase
      .from('users')
      .select('current_context')
      .eq('id', userId)
      .maybeSingle();

    return {
      content: data?.current_context || '',
      themes: [],
      isFallback: true,
    };
  } catch {
    return { content: '', themes: [], isFallback: true };
  }
}
// ─── Bloco 4: Leitor de HD ───────────────────────────────────────────────────
// Cole após o Bloco 3 no arquivo lib/memory/index.ts
//
// Responsabilidade: busca memórias de longo prazo via similaridade semântica.
// Threshold e match_count adaptativos por contexto:
//   - retrospecto → threshold menor, mais resultados
//   - emocional alto → segunda busca com threshold ainda menor
//   - trivial/casual → pula completamente

const HD_THRESHOLD_DEFAULT  = 0.22;
const HD_THRESHOLD_RETRO    = 0.15;
const HD_THRESHOLD_EMOTIONAL = 0.12;
const HD_MATCH_DEFAULT      = 8;
const HD_MATCH_RETRO        = 12;
const HD_MATCH_EMOTIONAL    = 12;

export async function readHD(
  userId: string,
  queryEmbedding: number[] | null,
  contexts: string[],
  emotionalScore: number,
): Promise<HDResult> {
  const empty: HDResult = { memories: [], block: '', memoryIds: [] };

  if (!queryEmbedding) return empty;

  const isRetrospecto = contexts.includes('retrospecto');
  const threshold  = isRetrospecto ? HD_THRESHOLD_RETRO : HD_THRESHOLD_DEFAULT;
  const matchCount = isRetrospecto ? HD_MATCH_RETRO     : HD_MATCH_DEFAULT;

  try {
    const { data: search, error } = (await supabase.rpc('match_memories', {
      query_embedding: queryEmbedding,
      match_threshold: threshold,
      match_count:     matchCount,
    })) as { data: any[] | null; error?: any };

    if (error) {
      console.error('[MemoryManager/HD] Erro na RPC:', error);
      return empty;
    }

    let results = search || [];

    // Segunda busca com threshold menor quando score emocional é alto
    if (emotionalScore > 0.6 && results.length < 6) {
      try {
        const { data: extraSearch } = (await supabase.rpc('match_memories', {
          query_embedding: queryEmbedding,
          match_threshold: HD_THRESHOLD_EMOTIONAL,
          match_count:     HD_MATCH_EMOTIONAL,
        })) as { data: any[] | null };

        if (extraSearch?.length) {
          const existingIds = new Set(results.map((r: any) => r.id));
          const extras = extraSearch.filter((r: any) => !existingIds.has(r.id));
          if (extras.length) {
            results = [...results, ...extras];
            console.log(`[MemoryManager/HD] Segunda busca emocional: +${extras.length} memórias`);
          }
        }
      } catch (err) {
        console.error('[MemoryManager/HD] Erro na segunda busca:', err);
      }
    }

    if (!results.length) return empty;

    const memories = results.map((r: any) => ({
      id:               r.id,
      summary:          r.summary,
      similarity:       r.similarity,
      emotional_weight: r.emotional_weight ?? 0.5,
    }));

    const block = memories
      .filter(r => !r.summary?.startsWith('[CINZA]'))
      .map(r => r.summary)
      .join('\n---\n');

    const memoryIds = memories.map(r => r.id);

    console.log(`[MemoryManager/HD] ${memories.length} memórias carregadas | threshold: ${threshold}`);

    return { memories, block, memoryIds };

  } catch (e) {
    console.error('[MemoryManager/HD] Exceção:', e);
    return empty;
  }
}

// ─── Bloco 5: Leitor de Ashes ─────────────────────────────────────────────────
// Cole após o Bloco 4 no arquivo lib/memory/index.ts
//
// Responsabilidade: lê memórias distantes consolidadas (memory_ashes).
// Só carrega quando há contexto relacional profundo ou planejamento de longo prazo.
// Ao citar ashes no prompt, o modelo deve usar "lembro vagamente que..."
// para sinalizar que é uma memória antiga e possivelmente imprecisa.

const ASHES_CONTEXTS = ['diario', 'emocao', 'meta', 'familia'];
const ASHES_LIMIT    = 5;

export async function readAshes(
  userId: string,
  contexts: string[],
  emotionalScore: number,
): Promise<AshesResult> {
  const empty: AshesResult = { block: '', periods: [] };

  // Só carrega quando há contexto relacional profundo ou emoção real
  const shouldLoad =
    contexts.some(c => ASHES_CONTEXTS.includes(c)) &&
    (emotionalScore > 0.3 || contexts.includes('diario') || contexts.includes('meta'));

  if (!shouldLoad) return empty;

  try {
    const { data, error } = await supabase
      .from('memory_ashes')
      .select('ash_summary, period_start, period_end')
      .eq('user_id', userId)
      .order('period_end', { ascending: false })
      .limit(ASHES_LIMIT);

    if (error) {
      console.error('[MemoryManager/Ashes] Erro:', error.message);
      return empty;
    }

    if (!data?.length) return empty;

    const periods = data.map((a: any) => ({
      summary:      a.ash_summary,
      period_start: a.period_start,
      period_end:   a.period_end,
    }));

    const block = periods.map(p => p.summary).join('\n');

    console.log(`[MemoryManager/Ashes] ${periods.length} períodos carregados`);

    return { block, periods };

  } catch (e) {
    console.error('[MemoryManager/Ashes] Exceção:', e);
    return empty;
  }
}

// ─── Bloco 6: Leitor de Events ───────────────────────────────────────────────
// Cole após o Bloco 5 no arquivo lib/memory/index.ts
//
// Responsabilidade: lê eventos e datas importantes do usuário.
// Separa em três grupos:
//   - upcoming: próximos 7 dias (alta prioridade no prompt)
//   - important: relevance_score >= 0.7 fora dos próximos 7 dias
//   - active: todos os eventos válidos (upcoming + permanent passados)

const EVENTS_UPCOMING_DAYS    = 7;
const EVENTS_HIGH_RELEVANCE   = 0.7;
const EVENTS_HOLIDAY_CONTEXTS = ['agenda', 'evento', 'familia'];

export async function readEvents(
  userId: string,
  contexts: string[],
  canonicalDateISO: string,
): Promise<EventsResult> {
  const empty: EventsResult = { upcoming: [], important: [], block: '' };

  try {
    const { data, error } = await supabase
      .from('events')
      .select('title, event_date, category, decay_type, relevance_score, emotional_weight, is_recurring, notes')
      .eq('user_id', userId)
      .order('relevance_score', { ascending: false });

    if (error) {
      console.error('[MemoryManager/Events] Erro:', error.message);
      return empty;
    }

    if (!data?.length) return empty;

    const hoje = new Date(canonicalDateISO);
    hoje.setHours(0, 0, 0, 0);

    const sorted = [...data].sort(
      (a, b) =>
        Math.abs(new Date(a.event_date).getTime() - hoje.getTime()) -
        Math.abs(new Date(b.event_date).getTime() - hoje.getTime())
    );

    const upcoming = sorted.filter(e => {
      const diff = Math.ceil(
        (new Date(e.event_date).getTime() - hoje.getTime()) / 86400000
      );
      return diff >= 0 && diff <= EVENTS_UPCOMING_DAYS;
    });

    const important = sorted.filter(
      e => (e.relevance_score || 0) >= EVENTS_HIGH_RELEVANCE && !upcoming.includes(e)
    );

    const active = sorted.filter(
      e =>
        new Date(e.event_date) >= hoje ||
        (e.decay_type === 'permanent' && new Date(e.event_date) < hoje)
    );

    // Monta bloco de texto para o prompt
    const parts: string[] = [];

    if (upcoming.length > 0) {
      parts.push(
        `🔴 NOS PRÓXIMOS DIAS:\n${upcoming
          .map(e => `  - ${e.title}: ${e.event_date}${e.notes ? ` (${e.notes})` : ''}`)
          .join('\n')}`
      );
    }

    if (important.length > 0) {
      parts.push(
        `🟡 IMPORTANTES:\n${important
          .map(e => `  - ${e.title}: ${e.event_date}`)
          .join('\n')}`
      );
    }

    const block = active.length > 0
      ? parts.join('\n\n')
      : 'Nenhum evento cadastrado.';

    // Feriados — só carrega quando contexto é relevante
    let holidaysBlock = '';
    const needsHolidays = contexts.some(c => EVENTS_HOLIDAY_CONTEXTS.includes(c));
    if (needsHolidays) {
      try {
        const { getUpcomingHolidays } = await import('@/lib/holidays');
        const holidays = await getUpcomingHolidays(10);
        if (holidays.length > 0) {
          holidaysBlock = `\n[FERIADOS NACIONAIS PRÓXIMOS]\n${holidays
            .map((h: any) => `- ${h.name}: ${new Date(h.date).toLocaleDateString('pt-BR')}`)
            .join('\n')}`;
        }
      } catch (err) {
        console.error('[MemoryManager/Events] Erro ao buscar feriados:', err);
      }
    }

    console.log(
      `[MemoryManager/Events] upcoming=${upcoming.length} important=${important.length} active=${active.length}`
    );

    return {
      upcoming,
      important,
      block: block + holidaysBlock,
    };

  } catch (e) {
    console.error('[MemoryManager/Events] Exceção:', e);
    return empty;
  }
}

// ─── Bloco 7: Leitor de Topics e Recommendations ─────────────────────────────
// Cole após o Bloco 6 no arquivo lib/memory/index.ts
//
// Responsabilidade: lê padrões recorrentes (topic_index) e recomendações,
// filtrando por relevância para a mensagem atual.
// Também carrega tópicos relacionados ao contexto dominante.

const TOPICS_CONTEXTS = [
  'saude', 'projeto', 'familia', 'rotina', 'preferencia',
];

const RECOMMENDATIONS_CONTEXTS = [
  'recomendacao', 'retrospecto',
];

export async function readTopicsAndRecommendations(
  userId: string,
  contexts: string[],
  message: string,
  emotionalScore: number,
): Promise<TopicsResult> {
  const empty: TopicsResult = {
    topicBlock: '',
    recommendationsBlock: '',
    relatedTopicsBlock: '',
  };

  const isRetrospecto    = contexts.includes('retrospecto');
  const wantsRec         = contexts.some(c => RECOMMENDATIONS_CONTEXTS.includes(c)) ||
    /me indica|me recomenda|onde (posso|vai|tem)|tem algum|conhece (algum|alguma)|me sugere|você me (indicou|sugeriu|recomendou)/i.test(message);
  const needsTopics      = contexts.some(c => TOPICS_CONTEXTS.includes(c));
  const dominantContext  = contexts[0] || 'casual';

  try {
    const [topicBlock, recommendationsBlock, relatedTopicsBlock] = await Promise.all([
      // Tópicos recorrentes — só quando contexto relacional
      needsTopics
        ? buildTopicBlock(userId, message).catch(() => '')
        : Promise.resolve(''),

      // Recomendações — quando pediu sugestão ou é retrospecto
      wantsRec || isRetrospecto
        ? buildRecommendationsBlock(userId, message).catch(() => '')
        : Promise.resolve(''),

      // Tópicos relacionados ao contexto dominante
      needsTopics || isRetrospecto
        ? getRelatedTopics(userId, dominantContext).catch(() => '')
        : Promise.resolve(''),
    ]);

    const loaded = [
      topicBlock         ? 'topics'        : null,
      recommendationsBlock ? 'recommendations' : null,
      relatedTopicsBlock   ? 'related'        : null,
    ].filter(Boolean);

    if (loaded.length > 0) {
      console.log(`[MemoryManager/Topics] Carregados: ${loaded.join(', ')}`);
    }

    return { topicBlock, recommendationsBlock, relatedTopicsBlock };

  } catch (e) {
    console.error('[MemoryManager/Topics] Exceção:', e);
    return empty;
  }
}// ─── Bloco 8: Leitor de Relacionamento ───────────────────────────────────────
// Cole após o Bloco 7 no arquivo lib/memory/index.ts
//
// Responsabilidade: lê memórias e eventos do relacionamento,
// respeitando permissões e privacidade.
//
// Fluxo:
//   1. Busca relacionamentos ativos do usuário
//   2. Verifica permissões via relationship_permissions
//   3. Filtra itens ocultos via relationship_privacy_choices
//   4. Busca memórias semânticas do relacionamento (relationship_memories)
//   5. Busca eventos do relacionamento (relationship_events)

const RELATIONSHIP_CONTEXTS = ['familia', 'evento', 'emocao', 'diario', 'retrospecto'];
const RELATIONSHIP_MEMORY_THRESHOLD = 0.25;
const RELATIONSHIP_MEMORY_COUNT     = 4;

export async function readRelationship(
  userId: string,
  authUserId: string,
  queryEmbedding: number[] | null,
  contexts: string[],
  message: string,
): Promise<RelationshipResult> {
  const empty: RelationshipResult = {
    hasData: false,
    block: '',
    sharedMemories: [],
    sharedEvents: [],
    hiddenItems: [],
  };

  // Só carrega quando contexto é relevante
  const shouldLoad = contexts.some(c => RELATIONSHIP_CONTEXTS.includes(c)) ||
    /giselle|esposa|cônjuge|conjuge|parceira|aniversário dela|presente (dela|pra ela)|surpresa/i.test(message);

  if (!shouldLoad) return empty;

  try {
    // 1. Busca relacionamentos ativos
    const { data: relationships, error: relError } = await supabase
      .from('relationships')
      .select('id, relation_type, nickname, metadata')
      .or(`user_id_a.eq.${userId},user_id_b.eq.${userId}`)
      .limit(5);

    if (relError || !relationships?.length) return empty;

    const parts: string[] = [];
    let allSharedMemories: RelationshipResult['sharedMemories'] = [];
    let allSharedEvents:   RelationshipResult['sharedEvents']   = [];
    let allHiddenItems:    RelationshipResult['hiddenItems']     = [];

    for (const rel of relationships) {
      // 2. Verifica se memories_shared está permitido
      const { data: permission } = await supabase
        .from('relationship_permissions')
        .select('is_active')
        .eq('relationship_id', rel.id)
        .eq('permission', 'memories_shared')
        .eq('is_active', true)
        .maybeSingle();

      // Se não há permissão explícita, pula memórias mas mantém eventos
      const canReadMemories = !!permission;

      // 3. Itens ocultos do usuário atual (presentes, surpresas)
      const { data: hiddenItems } = await supabase
        .from('relationship_privacy_choices')
        .select('resource, reveal_at, note')
        .eq('relationship_id', rel.id)
        .eq('owner_id', authUserId)
        .eq('revealed', false)
        .in('scope', ['gift', 'resource']);

      if (hiddenItems?.length) {
        allHiddenItems.push(...hiddenItems.map((h: any) => ({
          resource:  h.resource,
          reveal_at: h.reveal_at,
          note:      h.note,
        })));
      }

      // 4. Memórias semânticas do relacionamento
      if (canReadMemories && queryEmbedding) {
        const { data: relMemories } = await supabase
        .rpc('match_relationship_memories', {
        query_embedding:   queryEmbedding,
        p_relationship_id: rel.id,
        match_threshold:   RELATIONSHIP_MEMORY_THRESHOLD,
        match_count:       RELATIONSHIP_MEMORY_COUNT,
        })
        .then(
        (res) => res,
        ()    => ({ data: null }),
        ) as any;
        if (relMemories?.length) {
          allSharedMemories.push(...relMemories.map((m: any) => ({
            summary:    m.summary,
            similarity: m.similarity,
          })));

          parts.push(
            `[MEMÓRIAS DO RELACIONAMENTO — ${rel.relation_type}]\n` +
            relMemories.map((m: any) => m.summary).join('\n---\n')
          );
        }
      }

      // 5. Eventos do relacionamento (aniversário de casamento, marcos)
      const { data: relEvents } = await supabase
        .from('relationship_events')
        .select('title, event_date, emotional_weight, notes, is_recurring')
        .eq('relationship_id', rel.id)
        .order('event_date', { ascending: true });

      if (relEvents?.length) {
        allSharedEvents.push(...relEvents.map((e: any) => ({
          title:            e.title,
          event_date:       e.event_date,
          emotional_weight: e.emotional_weight,
        })));

        const hoje = new Date();
        const proximos = relEvents.filter((e: any) => {
          const diff = Math.ceil(
            (new Date(e.event_date).getTime() - hoje.getTime()) / 86400000
          );
          return diff >= 0 && diff <= 30;
        });

        if (proximos.length > 0) {
          parts.push(
            `[DATAS DO RELACIONAMENTO — próximos 30 dias]\n` +
            proximos.map((e: any) =>
              `- ${e.title}: ${e.event_date}${e.notes ? ` (${e.notes})` : ''}`
            ).join('\n')
          );
        }
      }
    }

    const hasData = parts.length > 0 ||
      allSharedMemories.length > 0 ||
      allSharedEvents.length > 0;

    if (hasData) {
      console.log(
        `[MemoryManager/Relationship] memories=${allSharedMemories.length} events=${allSharedEvents.length} hidden=${allHiddenItems.length}`
      );
    }

    return {
      hasData,
      block:          parts.join('\n\n'),
      sharedMemories: allSharedMemories,
      sharedEvents:   allSharedEvents,
      hiddenItems:    allHiddenItems,
    };

  } catch (e) {
    console.error('[MemoryManager/Relationship] Exceção:', e);
    return empty;
  }
}

// ─── Bloco 9: Agregador principal (read) ─────────────────────────────────────
// Cole após o Bloco 8 no arquivo lib/memory/index.ts
//
// Responsabilidade: orquestra todos os leitores em paralelo,
// decide quais camadas carregar baseado em contexto e necessidade,
// e retorna o resultado consolidado para o route.ts.
//
// Ordem de execução:
//   1. HD primeiro — RAM precisa do hdBlock para fallback semântico
//   2. L3, Ashes, Events, Topics, Relationship em paralelo
//   3. RAM por último — usa hdBlock do passo 1

export async function read(options: MemoryReadOptions): Promise<MemoryReadResult> {
  const start = Date.now();
  const {
    userId,
    authUserId,
    sessionId,
    queryEmbedding,
    contexts,
    message,
    emotionalScore,
    authorName,
    layers: layerOverrides,
  } = options;

  // Decide quais camadas carregar
  const plan = planContextualBlocks(contexts as any[], message, emotionalScore);
  const layers = {
    ram:             true,
    l3:              plan.loadL3,
    hd:              plan.loadHD,
    ashes:           plan.loadAshes,
    events:          true, // sempre — eventos próximos são sempre relevantes
    topics:          plan.loadTopics || plan.loadRecommendations,
    recommendations: plan.loadRecommendations,
    relationship:    true, // sempre — custo baixo, valor alto
    ...layerOverrides,
  };

  const layersLoaded:  MemoryLayer[] = [];
  const layersSkipped: MemoryLayer[] = [];

  // Registra quais camadas serão carregadas
  for (const [layer, active] of Object.entries(layers)) {
    if (active) layersLoaded.push(layer as MemoryLayer);
    else        layersSkipped.push(layer as MemoryLayer);
  }

  // ── Passo 1: HD primeiro (RAM precisa do hdBlock) ────────────────────────
  const hd = layers.hd
    ? await readHD(userId, queryEmbedding, contexts, emotionalScore)
    : { memories: [], block: '', memoryIds: [] };

  // ── Passo 2: Camadas independentes em paralelo ───────────────────────────
  const [l3, ashes, events, topics, relationship] = await Promise.all([
    layers.l3
      ? readL3(userId, queryEmbedding)
      : Promise.resolve({ content: '', themes: [], isFallback: true }),

    layers.ashes
      ? readAshes(userId, contexts, emotionalScore)
      : Promise.resolve({ block: '', periods: [] }),

    layers.events
      ? readEvents(userId, contexts, new Date().toISOString().split('T')[0])
      : Promise.resolve({ upcoming: [], important: [], block: '' }),

    layers.topics
      ? readTopicsAndRecommendations(userId, contexts, message, emotionalScore)
      : Promise.resolve({ topicBlock: '', recommendationsBlock: '', relatedTopicsBlock: '' }),

    layers.relationship
      ? readRelationship(userId, authUserId, queryEmbedding, contexts, message)
      : Promise.resolve({ hasData: false, block: '', sharedMemories: [], sharedEvents: [], hiddenItems: [] }),
  ]);

  // ── Passo 3: RAM por último (usa hd.block como fallback semântico) ────────
  const assistantName = 'Lev'; // será sobrescrito pelo route.ts se necessário
  const ram = await readRAM(
    userId,
    sessionId,
    contexts,
    message,
    authorName,
    assistantName,
    queryEmbedding,
    hd.block,
  );

  const durationMs = Date.now() - start;

  console.log(
    `[MemoryManager] read concluído em ${durationMs}ms | ` +
    `loaded: ${layersLoaded.join(', ')} | ` +
    `skipped: ${layersSkipped.join(', ')}`
  );

  return {
    ram,
    l3,
    hd,
    ashes,
    events,
    topics,
    relationship,
    meta: {
      userId,
      sessionId,
      layersLoaded,
      layersSkipped,
      durationMs,
    },
  };
}

// ─── Bloco 10: Escritor ───────────────────────────────────────────────────────
// Cole após o Bloco 9 no arquivo lib/memory/index.ts
//
// Responsabilidade: roteia escritas para a camada correta,
// evita duplicatas e garante que informações importantes
// sejam indexadas no HD para recuperação futura.


export async function write(payload: MemoryWritePayload): Promise<void> {
  const { type, userId } = payload;

  try {
    switch (type) {

      // ── Conversa → brain ────────────────────────────────────────────────
      case 'conversation': {
        if (!payload.messageText || !payload.sessionId) return;
        await supabase.from('brain').insert([{
          content:     payload.messageText,
          category:    payload.category || 'info',
          user_id:     userId,
          session_id:  payload.sessionId,
          project_tag: 'geral',
          embedding:   payload.embedding ?? undefined,
          metadata:    payload.metadata || {},
        }]);
        break;
      }

      // ── Fato → HD (memories) ─────────────────────────────────────────────
      case 'fact': {
        if (!payload.summary) return;
        const embedding = payload.embedding ?? await generateEmbedding(payload.summary);
        if (!embedding) {
          console.warn('[MemoryManager/write] fact: embedding falhou, não indexado');
          return;
        }
        await supabase.from('memories').insert([{
          summary:          payload.summary,
          embedding,
          user_id:          userId,
          relevance_score:  0.8,
          access_count:     0,
          decay_lambda:     0.003,
          emotional_weight: payload.emotionalWeight ?? 0.6,
          category:         payload.category || 'fact',
          metadata:         { type: 'fact', source: 'conversation' },
        }]);
        console.log('[MemoryManager/write] fact salvo no HD:', payload.summary?.slice(0, 60));
        break;
      }

      // ── Recomendação → recommendations + HD ──────────────────────────────
      case 'recommendation': {
        if (!payload.summary) return;

        // Verifica duplicata em recommendations
        const { data: existing } = await supabase
          .from('recommendations')
          .select('id')
          .eq('user_id', userId)
          .ilike('name', payload.summary.slice(0, 50))
          .maybeSingle();

        if (!existing) {
          await supabase.from('recommendations').insert({
            user_id:     userId,
            type:        payload.category || 'outro',
            name:        payload.summary,
            source:      'jarvis',
            status:      'pending',
          });
        }

        // Sempre salva no HD para recuperação semântica futura
        const embedding = payload.embedding ?? await generateEmbedding(payload.summary);
        if (embedding) {
          await supabase.from('memories').insert([{
            summary:          payload.summary,
            embedding,
            user_id:          userId,
            relevance_score:  0.8,
            access_count:     0,
            decay_lambda:     0.003,
            emotional_weight: payload.emotionalWeight ?? 0.6,
            category:         'recommendation',
            metadata:         { type: 'recommendation', source: 'conversation' },
          }]);
        }
        console.log('[MemoryManager/write] recommendation salva:', payload.summary?.slice(0, 60));
        break;
      }

      // ── Evento → events ──────────────────────────────────────────────────
      case 'event': {
        if (!payload.title || !payload.eventDate) return;
        const { upsertEvent } = await import('@/lib/extractor-jobs');
        await upsertEvent(userId, {
          title:            payload.title,
          event_date:       payload.eventDate,
          category:         payload.category || 'Pessoal',
          priority:         'media',
          decay_type:       payload.isRecurring ? 'recurring_annual' : 'one_time',
          emotional_weight: payload.emotionalWeight ?? 0.6,
          is_recurring:     payload.isRecurring ?? false,
          notes:            payload.notes || null,
        });
        break;
      }

      // ── Diário → diary_entries ────────────────────────────────────────────
      case 'diary': {
        if (!payload.summary) return;
        const { extractDiary } = await import('@/lib/diary');
        await extractDiary(userId, payload.summary, 'anytime');
        break;
      }

      // ── Meta → goals ──────────────────────────────────────────────────────
      case 'goal': {
        if (!payload.summary) return;
        const { extractGoal } = await import('@/lib/diary');
        await extractGoal(userId, payload.summary);
        break;
      }

      // ── Perfil → user_profiles ────────────────────────────────────────────
      case 'profile': {
        if (!payload.profileData) return;
        await supabase
          .from('user_profiles')
          .upsert({
            user_id:    userId,
            ...payload.profileData,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' });
        break;
      }

      // ── Dossiê → current_context + l3_chunks ─────────────────────────────
      case 'l3_patch': {
        if (!payload.dossie) return;
        await supabase
          .from('users')
          .update({
            current_context: payload.dossie,
            updated_at:      new Date().toISOString(),
          })
          .eq('id', userId);

        // Reindexar chunks em background
        indexL3Chunks(Number(userId), payload.dossie).catch(e =>
          console.error('[MemoryManager/write] l3_patch reindexação falhou:', e)
        );
        break;
      }

      // ── Memória do relacionamento → relationship_memories ─────────────────
      case 'relationship_memory': {
        if (!payload.summary || !payload.relationshipId) return;
        const embedding = payload.embedding ?? await generateEmbedding(payload.summary);
        await supabase.from('relationship_memories').insert({
          relationship_id: payload.relationshipId,
          summary:         payload.summary,
          embedding,
          frozen_by:       'system',
        });
        break;
      }

      // ── Evento do relacionamento → relationship_events ────────────────────
      case 'relationship_event': {
        if (!payload.title || !payload.eventDate || !payload.relationshipId) return;
        await supabase.from('relationship_events').insert({
          relationship_id:  payload.relationshipId,
          title:            payload.title,
          event_date:       payload.eventDate,
          category:         payload.category || 'milestone',
          is_recurring:     payload.isRecurring ?? false,
          emotional_weight: payload.emotionalWeight ?? 0.8,
          notes:            payload.notes || null,
          created_by:       Number(userId),
        });
        break;
      }

      default:
        console.warn('[MemoryManager/write] Tipo desconhecido:', type);
    }
  } catch (e) {
    console.error(`[MemoryManager/write] Erro ao salvar tipo ${type}:`, e);
  }
}// ─── Bloco 11: Exportações ────────────────────────────────────────────────────
// Cole após o Bloco 10 no arquivo lib/memory/index.ts
//
// Exporta o MemoryManager como interface pública única.
// Nenhum módulo externo deve importar funções individuais (readHD, readL3, etc.)
// — tudo passa pelo MemoryManager.

export const MemoryManager = {
  read,
  write,
} as const;

export default MemoryManager;

