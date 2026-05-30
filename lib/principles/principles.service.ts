// lib/principles/principles.service.ts

import { supabase } from '@/lib/jarvis';
import { generateEmbedding } from '@/lib/memory/generate-embedding';
import { invalidateContextField } from '../services/context-cache';
import { encrypt, decrypt, hashBlindIndex } from '@/lib/crypto-utils';

export interface PrincipleUpsertInput {
  userId: number;
  content: string;
  category?: string;
  source?: 'manual' | 'extracted' | 'promoted';
  patternKey?: string;
  confidenceDelta?: number;
  tags?: string[];
}

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

  const embedding = await generateEmbedding(content);
  const encryptedContent = encrypt(content);

  const blindTags = tags.map(tag => hashBlindIndex(tag));
  blindTags.push(hashBlindIndex(category));

  if (patternKey) {
    const { data: existing } = await supabase
      .from('principles')
      .select('id, confidence')
      .eq('user_id', userId)
      .eq('pattern_key', patternKey)
      .single();

    if (existing) {
      const newConfidence = Math.min(1.0, existing.confidence + confidenceDelta);
      await supabase
        .from('principles')
        .update({
          content: encryptedContent,
          is_encrypted: true,
          blind_tags: blindTags,
          confidence: newConfidence,
          embedding: embedding || null,
          promoted_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else {
      await supabase
        .from('principles')
        .insert({
          user_id: userId,
          content: encryptedContent,
          category,
          source,
          pattern_key: patternKey,
          confidence: 0.5,
          embedding: embedding || null,
          is_encrypted: true,
          blind_tags: blindTags,
        });
    }
  } else {
    await supabase
      .from('principles')
      .insert({
        user_id: userId,
        content: encryptedContent,
        category,
        source,
        confidence: source === 'manual' ? 1.0 : 0.5,
        embedding: embedding || null,
        is_encrypted: true,
        blind_tags: blindTags,
      });
  }

  await invalidateContextField(userId, 'principles');
}

export async function getPrinciples(userId: number, minConfidence = 0.4) {
  const { data, error } = await supabase
    .from('principles')
    .select('id, content, category, confidence, source, created_at, is_encrypted')
    .eq('user_id', userId)
    .gte('confidence', minConfidence)
    .order('confidence', { ascending: false });

  if (error) throw error;

  return (data ?? []).map(row => ({
    ...row,
    content: row.is_encrypted ? decrypt(row.content) : row.content
  }));
}

export async function findSimilarPrinciples(
  userId: number,
  text: string,
  threshold = 0.85,
  limit = 3
) {
  const embedding = await generateEmbedding(text);

  // Trava de Segurança: Aborta a busca se o embedding falhou
  if (!embedding) {
    console.warn('[Principles] Falha ao gerar embedding. Retornando similaridade vazia.');
    return [];
  }

  const { data, error } = await supabase
    .rpc('match_principles', {
      p_user_id: userId,
      p_embedding: embedding,
      p_threshold: threshold,
      p_limit: limit,
    });

  if (error) throw error;

  return (data ?? []).map((row: any) => ({
    ...row,
    content: row.is_encrypted ? decrypt(row.content) : row.content
  }));
}

export async function decayOldPrinciples(userId: number): Promise<void> {
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const { data: stale } = await supabase
    .from('principles')
    .select('id, confidence, content')
    .eq('user_id', userId)
    .lt('promoted_at', ninetyDaysAgo.toISOString())
    .gt('confidence', 0.2); 

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