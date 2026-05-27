// lib/principles/principles.service.ts

import { createClient } from '@supabase/supabase-js';
import { invalidateContextField } from '../services/context-cache'; // ajuste para seu path real

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export interface PrincipleUpsertInput {
  userId: number;
  content: string;
  category?: string;
  source?: 'manual' | 'extracted' | 'promoted';
  patternKey?: string;
  confidenceDelta?: number; // quanto aumentar/diminuir a confiança
}

/**
 * Salva ou atualiza um princípio.
 * Se já existe (mesmo userId + patternKey), incrementa confidence.
 * Invalida o cache de contexto após escrita.
 */
export async function upsertPrinciple(input: PrincipleUpsertInput): Promise<void> {
  const {
    userId,
    content,
    category = 'Filosofia e Moral',
    source = 'extracted',
    patternKey,
    confidenceDelta = 0.1,
  } = input;

  // Gera embedding via OpenAI (ou seu provider atual)
  const embedding = await generateEmbedding(content);

  if (patternKey) {
    // Upsert por pattern_key — incrementa confidence se já existe
    const { data: existing } = await supabase
      .schema('jarvis')
      .from('principles')
      .select('id, confidence')
      .eq('user_id', userId)
      .eq('pattern_key', patternKey)
      .single();

    if (existing) {
      const newConfidence = Math.min(1.0, existing.confidence + confidenceDelta);
      await supabase
        .schema('jarvis')
        .from('principles')
        .update({
          content,
          confidence: newConfidence,
          embedding,
          promoted_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else {
      await supabase
        .schema('jarvis')
        .from('principles')
        .insert({
          user_id: userId,
          content,
          category,
          source,
          pattern_key: patternKey,
          confidence: 0.5, // começa baixo, cresce com reforço
          embedding,
        });
    }
  } else {
    // Inserção direta sem deduplicação por pattern_key
    await supabase
      .schema('jarvis')
      .from('principles')
      .insert({
        user_id: userId,
        content,
        category,
        source,
        confidence: source === 'manual' ? 1.0 : 0.5,
        embedding,
      });
  }

  // Invalida o cache — próxima conversa vai buscar do banco
  await invalidateContextField(userId, 'principles');
}

/**
 * Busca os princípios ativos do usuário, ordenados por confiança.
 */
export async function getPrinciples(userId: number, minConfidence = 0.4) {
  const { data, error } = await supabase
    .schema('jarvis')
    .from('principles')
    .select('id, content, category, confidence, source, created_at')
    .eq('user_id', userId)
    .gte('confidence', minConfidence)
    .order('confidence', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

/**
 * Busca princípios semanticamente similares a um texto.
 * Útil para detectar contradições antes de salvar um novo princípio.
 */
export async function findSimilarPrinciples(
  userId: number,
  text: string,
  threshold = 0.85,
  limit = 3
) {
  const embedding = await generateEmbedding(text);

  const { data, error } = await supabase
    .schema('jarvis')
    .rpc('match_principles', {
      p_user_id: userId,
      p_embedding: embedding,
      p_threshold: threshold,
      p_limit: limit,
    });

  if (error) throw error;
  return data ?? [];
}

/**
 * Decai princípios antigos sem reforço recente.
 * Rodar periodicamente (ex: cron semanal).
 */
export async function decayOldPrinciples(userId: number): Promise<void> {
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  // Busca princípios sem reforço recente
  const { data: stale } = await supabase
    .schema('jarvis')
    .from('principles')
    .select('id, confidence, content')
    .eq('user_id', userId)
    .lt('promoted_at', ninetyDaysAgo.toISOString())
    .gt('confidence', 0.2); // não decai abaixo de 0.2

  if (!stale?.length) return;

  for (const principle of stale) {
    const newConfidence = Math.max(0.2, principle.confidence - 0.05);
    await supabase
      .schema('jarvis')
      .from('principles')
      .update({ confidence: newConfidence })
      .eq('id', principle.id);
  }

  await invalidateContextField(userId, 'principles');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function generateEmbedding(text: string): Promise<number[]> {
  // Adapte para seu provider de embeddings atual
  // Ex: OpenAI text-embedding-3-small via llmGateway
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
  });

  const data = await response.json();
  return data.data[0].embedding;
}