// lib/memory/memory-retrieval.ts
// Responsabilidade única: dado um embedding, buscar memórias semanticamente
// relevantes no HD e retornar bloco de texto pronto para o system prompt.
//
// Regra 1: só chamado quando shouldRetrieveMemory() = true
// Regra 3: não é módulo — pode fazer I/O, mas apenas UMA query
// Regra 4: não toca no Gateway — é leitura de contexto, não LLM

import { supabase } from '@/lib/jarvis';

const DEFAULT_THRESHOLD = 0.22;
const DEFAULT_LIMIT = 5;
const MAX_SUMMARY_CHARS = 200;

export interface MemoryItem {
  id: string;
  summary: string;
  similarity: number;
  emotional_weight: number;
}

/**
 * Busca memórias semanticamente relevantes para o embedding fornecido.
 * Retorna string vazia se não encontrar nada relevante.
 */
export async function retrieveRelevantMemories(
  userId: number,
  embedding: number[],
  options: {
    threshold?: number;
    limit?: number;
  } = {},
): Promise<string> {
  const { threshold = DEFAULT_THRESHOLD, limit = DEFAULT_LIMIT } = options;

  try {
    const { data, error } = await supabase.rpc('match_memories', {
      query_embedding: embedding,
      match_threshold: threshold,
      match_count: limit,
    });

    if (error) {
      console.error('[MemoryRetrieval] Erro no match_memories:', error.message);
      return '';
    }

    const memories: MemoryItem[] = (data || []).map((r: any) => ({
      id: r.id,
      summary: r.summary,
      similarity: r.similarity,
      emotional_weight: r.emotional_weight || 0.5,
    }));

    if (!memories.length) return '';

    // Ordena por combinação de similaridade e peso emocional
    const sorted = memories.sort(
      (a, b) =>
        b.similarity * 0.7 + b.emotional_weight * 0.3 -
        (a.similarity * 0.7 + a.emotional_weight * 0.3)
    );

    const lines = sorted.map(m =>
      `- ${m.summary.slice(0, MAX_SUMMARY_CHARS)}`
    );

    return lines.join('\n');
  } catch (e) {
    console.error('[MemoryRetrieval] Falha silenciosa:', e);
    return '';
  }
}