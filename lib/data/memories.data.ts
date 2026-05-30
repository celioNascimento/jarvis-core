// lib/data/memories.data.ts
//
// Tipagem central de MemoryRecord + loader de dados.
//
// Regra deste arquivo:
//   ✅ Types, interfaces, enums
//   ✅ Uma única função de leitura (loadMemoriesForContext) — pode acessar Supabase
//   ❌ Zero lógica de formatação (isso é responsabilidade do memory-block.ts)

import { supabase, generateEmbedding } from '@/lib/jarvis';

// ─── Categorias possíveis ────────────────────────────────────────────────────

export type MemoryCategory =
  | 'info'
  | 'event'
  | 'emotion'
  | 'preference'
  | 'belief'
  | 'goal'
  | 'relationship'
  | 'health'
  | 'finance'
  | 'work'
  | 'learning';

// ─── Record principal ────────────────────────────────────────────────────────

export interface MemoryRecord {
  /** UUID vindo da tabela `brain` no Supabase */
  id: string;

  /** Texto compacto da memória (já sumarizado pelo pipeline de extração) */
  summary: string;

  /** Categoria semântica da memória */
  category: MemoryCategory;

  /**
   * Peso emocional normalizado [0, 1].
   * 0 = sem carga emocional; 1 = experiência de máximo impacto.
   */
  emotional_weight: number;

  /**
   * Score composto de relevância para a conversa atual.
   * Calculado combinando similaridade semântica + recência + peso emocional.
   * Ausente quando a memória veio apenas por peso emocional.
   */
  effective_score?: number;

  /** Data de criação original (ISO 8601) */
  created_at?: string;

  /** Data do último acesso ou reforço */
  last_accessed_at?: string;

  /** Metadados extras livres (msg_id de origem, fonte, tags, etc.) */
  metadata?: Record<string, unknown>;
}

// ─── Resultado de carga ───────────────────────────────────────────────────────

export interface MemoriesLoadResult {
  /** Memórias rankeadas por effective_score (semântica + recência + emoção) */
  memories: MemoryRecord[];
  /** Memórias de alto peso emocional que não aparecem em `memories` */
  topEmotional: MemoryRecord[];
}

// ─── Constantes de carga ──────────────────────────────────────────────────────

/** Peso emocional mínimo para uma memória entrar no bloco topEmotional */
const TOP_EMOTIONAL_THRESHOLD = 0.6;

/** Quantas memórias de alto peso emocional exibir no máximo */
const TOP_EMOTIONAL_LIMIT = 3;

// ─── Loader principal ─────────────────────────────────────────────────────────

/**
 * Busca memórias relevantes para a conversa atual.
 *
 * - `memories`: top N rankeadas por effective_score (combinação de
 *   similaridade semântica, recência e peso emocional).
 * - `topEmotional`: memórias de alto impacto emocional que não
 *   estejam já em `memories`, garantindo que nunca se percam.
 *
 * Chama a RPC `get_relevant_memories` que deve retornar os campos
 * abaixo. Se a RPC falhar, retorna arrays vazios sem quebrar o pipeline.
 *
 * @param userId   ID numérico do usuário
 * @param message  Mensagem atual (usada como query semântica pela RPC)
 * @param limit    Máximo de memórias semânticas (default: 5)
 * @param minScore Score mínimo de relevância para incluir (default: 0.3)
 */
export async function loadMemoriesForContext(
  userId: number,
  message: string,
  limit = 5,
  minScore = 0.3,
): Promise<MemoriesLoadResult> {
  try {
    const embedding = await generateEmbedding(message);

    // Trava de Segurança Crítica: Protege o banco de dados contra vetores nulos
    if (!embedding) {
      console.warn('[memories.data] Embedding retornou null. Abortando busca semântica.');
      return { memories: [], topEmotional: [] };
    }

    const { data, error } = await supabase.rpc('get_relevant_memories', {
      p_user_id: userId,
      p_query: embedding,
      p_limit: limit,
      p_min_score: minScore,
    });

    if (error) {
      console.error('[memories.data] RPC get_relevant_memories falhou:', error.message);
      return { memories: [], topEmotional: [] };
    }

    if (!Array.isArray(data) || data.length === 0) {
      return { memories: [], topEmotional: [] };
    }

    const memories: MemoryRecord[] = data.map((row: any) => ({
      id: row.id,
      summary: row.content ?? row.summary ?? '',
      category: row.category ?? 'info',
      emotional_weight: row.emotional_score ?? row.emotional_weight ?? 0,
      effective_score: row.effective_score ?? undefined,
      created_at: row.created_at ?? undefined,
      last_accessed_at: row.last_accessed_at ?? undefined,
      metadata: row.metadata ?? undefined,
    }));

    const semanticIds = new Set(memories.map(m => m.id));

    const topEmotional: MemoryRecord[] = data
      .filter((row: any) =>
        !semanticIds.has(row.id) &&
        (row.emotional_score ?? row.emotional_weight ?? 0) >= TOP_EMOTIONAL_THRESHOLD
      )
      .slice(0, TOP_EMOTIONAL_LIMIT)
      .map((row: any) => ({
        id: row.id,
        summary: row.content ?? row.summary ?? '',
        category: row.category ?? 'info',
        emotional_weight: row.emotional_score ?? row.emotional_weight ?? 0,
        created_at: row.created_at ?? undefined,
        last_accessed_at: row.last_accessed_at ?? undefined,
        metadata: row.metadata ?? undefined,
      }));

    return { memories, topEmotional };

  } catch (err) {
    console.error('[memories.data] Erro inesperado em loadMemoriesForContext:', err);
    return { memories: [], topEmotional: [] };
  }
}