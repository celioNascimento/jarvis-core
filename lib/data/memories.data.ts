// lib/data/memories.data.ts
//
// Camada de dados: memórias com peso emocional e busca semântica.
// Chamada APENAS por intelligence.ts para popular masterContext.
//
// Contrato — Regra 1:
//   ✅ Lida por intelligence.ts → masterContext.memories
//   ❌ Nunca importada por módulos, prompts ou services

import { supabase } from '@/lib/jarvis';
import { generateEmbedding } from '@/lib/memory';

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface MemoryRecord {
  id:               string;
  summary:          string;
  emotional_weight: number;
  relevance_score:  number;
  category:         string;
  decay_type:       string;
  decay_lambda:     number;
  access_count:     number;
  project_tag:      string;
  created_at:       string;
  metadata:         Record<string, any>;
  // calculado localmente — não vem do banco
  effective_score?: number;
}

export interface MemoriesContextResult {
  memories:         MemoryRecord[];
  topEmotional:     MemoryRecord[];  // top 3 por peso emocional independente de similaridade
  retrievedAt:      string;
}

// ── Decay ─────────────────────────────────────────────────────────────────────
// Fórmula: relevance * e^(-lambda * days_old) * (1 + 0.1 * access_count)
// Memórias 'permanent' nunca decaem.

function applyDecay(memory: MemoryRecord): number {
  if (memory.decay_type === 'permanent') return memory.relevance_score;

  const daysOld = (Date.now() - new Date(memory.created_at).getTime()) / (1000 * 60 * 60 * 24);
  const decayed = memory.relevance_score * Math.exp(-memory.decay_lambda * daysOld);
  const accessBoost = 1 + 0.1 * Math.min(memory.access_count, 5); // cap em 5 boosts

  return Math.min(1.0, decayed * accessBoost);
}

// ── Score composto ────────────────────────────────────────────────────────────
// Combina similaridade semântica + peso emocional + relevância com decay

function computeEffectiveScore(
  memory: MemoryRecord,
  semanticSimilarity: number,
): number {
  const decayedRelevance = applyDecay(memory);

  // Pesos:
  //   50% similaridade semântica com a mensagem atual
  //   30% relevância com decay
  //   20% peso emocional
  return (
    0.5 * semanticSimilarity +
    0.3 * decayedRelevance +
    0.2 * memory.emotional_weight
  );
}

// ── Query principal ───────────────────────────────────────────────────────────

/**
 * Carrega memórias relevantes para a mensagem atual.
 * Chamada por intelligence.ts — resultado vai para masterContext.memories.
 *
 * @param userId      ID numérico do usuário
 * @param message     Mensagem atual (usada para embedding semântico)
 * @param limit       Máximo de memórias a retornar (padrão: 5)
 * @param minScore    Score mínimo para inclusão (padrão: 0.3)
 */
export async function loadMemoriesForContext(
  userId: number,
  message: string,
  limit    = 5,
  minScore = 0.3,
): Promise<MemoriesContextResult> {
  try {
    // Embedding da mensagem atual para busca semântica
    const embedding = await generateEmbedding(message);

    if (!embedding) {
      // Fallback: busca sem semântica, rankeada por relevance_score * emotional_weight
      return await loadMemoriesFallback(userId, limit);
    }

    // Busca semântica via pgvector + filtro por usuário
    const { data, error } = await supabase
      .schema('jarvis')
      .rpc('match_memories', {
        p_user_id:   userId,
        p_embedding: embedding,
        p_threshold: 0.2,          // threshold baixo — scoring local faz a filtragem real
        p_limit:     limit * 3,    // busca mais para poder rankear e filtrar
      });

    if (error) {
      console.warn('[memories.data] match_memories error:', error.message);
      return await loadMemoriesFallback(userId, limit);
    }

    if (!data?.length) {
      return { memories: [], topEmotional: [], retrievedAt: new Date().toISOString() };
    }

    // Aplica score composto e filtra
    const scored: MemoryRecord[] = (data as any[])
      .map(row => ({
        ...row,
        effective_score: computeEffectiveScore(row as MemoryRecord, row.similarity ?? 0),
      }))
      .filter(m => m.effective_score >= minScore)
      .sort((a, b) => (b.effective_score ?? 0) - (a.effective_score ?? 0))
      .slice(0, limit);

    // Top 3 emocionais — independente de similaridade com a mensagem atual
    // Garante que memórias de alto peso emocional nunca sejam esquecidas
    const topEmotional = (data as MemoryRecord[])
      .filter(m => m.emotional_weight >= 0.7)
      .sort((a, b) => b.emotional_weight - a.emotional_weight)
      .slice(0, 3);

    return {
      memories:    scored,
      topEmotional,
      retrievedAt: new Date().toISOString(),
    };

  } catch (e) {
    console.error('[memories.data] Erro ao carregar memórias:', e);
    return { memories: [], topEmotional: [], retrievedAt: new Date().toISOString() };
  }
}

// ── Fallback sem embedding ────────────────────────────────────────────────────

async function loadMemoriesFallback(
  userId: number,
  limit:  number,
): Promise<MemoriesContextResult> {
  const { data } = await supabase
    .schema('jarvis')
    .from('memories')
    .select('id, summary, emotional_weight, relevance_score, category, decay_type, decay_lambda, access_count, project_tag, created_at, metadata')
    .eq('user_id', userId)
    .order('relevance_score', { ascending: false })
    .limit(limit);

  const memories = (data ?? []).map(m => ({
    ...m,
    effective_score: applyDecay(m as MemoryRecord) * (m as any).emotional_weight,
  })) as MemoryRecord[];

  const topEmotional = memories
    .filter(m => m.emotional_weight >= 0.7)
    .sort((a, b) => b.emotional_weight - a.emotional_weight)
    .slice(0, 3);

  return { memories, topEmotional, retrievedAt: new Date().toISOString() };
}
