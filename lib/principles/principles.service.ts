// lib/principles/principles.service.ts

import { supabase } from '@/lib/jarvis'; // ← Importação centralizada (Fonte Única da Verdade)
import { invalidateContextField } from '../services/context-cache'; // ajuste para seu path real se necessário
import { encrypt, decrypt, hashBlindIndex } from '@/lib/crypto-utils';

export interface PrincipleUpsertInput {
  userId: number;
  content: string;
  category?: string;
  source?: 'manual' | 'extracted' | 'promoted';
  patternKey?: string;
  confidenceDelta?: number; // quanto aumentar/diminuir a confiança
  tags?: string[]; // Arrays de palavras-chave extraídas pelo LLM
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
    tags = [],
  } = input;

  // 1. Gera embedding via OpenAI a partir do texto puro (antes de cifrar)
  const embedding = await generateEmbedding(content);

  // 2. Criptografa o conteúdo longo
  const encryptedContent = encrypt(content);

  // 3. Gera o Índice Cego para as tags (incluindo a própria categoria)
  const blindTags = tags.map(tag => hashBlindIndex(tag));
  blindTags.push(hashBlindIndex(category));

  if (patternKey) {
    // Upsert por pattern_key — incrementa confidence se já existe
    const { data: existing } = await supabase
      .from('principles') // ← .schema('jarvis') removido pois já está no lib/jarvis.ts
      .select('id, confidence')
      .eq('user_id', userId)
      .eq('pattern_key', patternKey)
      .single();

    if (existing) {
      const newConfidence = Math.min(1.0, existing.confidence + confidenceDelta);
      await supabase
        .from('principles')
        .update({
          content: encryptedContent, // Dado cifrado
          is_encrypted: true,
          blind_tags: blindTags,
          confidence: newConfidence,
          embedding,
          promoted_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else {
      await supabase
        .from('principles')
        .insert({
          user_id: userId,
          content: encryptedContent, // Dado cifrado
          category,
          source,
          pattern_key: patternKey,
          confidence: 0.5, // começa baixo, cresce com reforço
          embedding,
          is_encrypted: true,
          blind_tags: blindTags,
        });
    }
  } else {
    // Inserção direta sem deduplicação por pattern_key
    await supabase
      .from('principles')
      .insert({
        user_id: userId,
        content: encryptedContent, // Dado cifrado
        category,
        source,
        confidence: source === 'manual' ? 1.0 : 0.5,
        embedding,
        is_encrypted: true,
        blind_tags: blindTags,
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
    .from('principles')
    .select('id, content, category, confidence, source, created_at, is_encrypted')
    .eq('user_id', userId)
    .gte('confidence', minConfidence)
    .order('confidence', { ascending: false });

  if (error) throw error;

  // Retorna os dados, decriptando caso a flag is_encrypted seja verdadeira
  return (data ?? []).map(row => ({
    ...row,
    content: row.is_encrypted ? decrypt(row.content) : row.content
  }));
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
    .rpc('match_principles', {
      p_user_id: userId,
      p_embedding: embedding,
      p_threshold: threshold,
      p_limit: limit,
    });

  if (error) throw error;

  // A RPC precisará ser ajustada no Supabase para também retornar a coluna is_encrypted.
  // Caso retorne, decriptamos o conteúdo recuperado pela similaridade vetorial.
  return (data ?? []).map((row: any) => ({
    ...row,
    content: row.is_encrypted ? decrypt(row.content) : row.content
  }));
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
    .from('principles')
    .select('id, confidence, content')
    .eq('user_id', userId)
    .lt('promoted_at', ninetyDaysAgo.toISOString())
    .gt('confidence', 0.2); // não decai abaixo de 0.2

  if (!stale?.length) return;

  for (const principle of stale) {
    const newConfidence = Math.max(0.2, principle.confidence - 0.05);
    await supabase
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