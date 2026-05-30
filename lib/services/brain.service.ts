// lib/services/brain.service.ts

import { supabase } from '@/lib/jarvis';
import { generateEmbedding } from '@/lib/memory/generate-embedding';
import { encrypt, decrypt, hashBlindIndex } from '@/lib/crypto-utils';
import { invalidateContextField } from '@/lib/services/context-cache';

export interface BrainInsertInput {
  userId: number;
  content: string;
  projectTag?: string;
  category?: 'Nota' | 'Dúvida' | 'Log_Tecnico' | 'Ideia_Estacionada' | 'Documentacao' | 'info' | 'noise' | 'archived';
  sessionId?: string;
  emotionalScore?: number;
  priorityScore?: number;
  tags?: string[];
}

export async function insertBrainEntry(input: BrainInsertInput) {
  const {
    userId,
    content,
    projectTag = 'geral',
    category = 'info',
    sessionId,
    emotionalScore,
    priorityScore = 3,
    tags = [],
  } = input;

  // 1. Gera o embedding (pode retornar null sem quebrar)
  const embedding = await generateEmbedding(content);

  // 2. Criptografa o conteúdo íntimo
  const encryptedContent = encrypt(content);

  // 3. Monta o Índice Cego (Hash)
  const rawTags = [...tags, category, projectTag];
  const blindTags = rawTags.map(tag => hashBlindIndex(tag));

  const { data, error } = await supabase
    .from('brain')
    .insert({
      user_id: userId,
      content: encryptedContent,
      is_encrypted: true,
      blind_tags: blindTags,
      embedding: embedding || null, // Salva null pacificamente se falhar
      project_tag: projectTag,
      category,
      session_id: sessionId,
      emotional_score: emotionalScore,
      priority_score: priorityScore,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Falha ao inserir no brain: ${error.message}`);

  return data;
}

export async function getRecentBrainEntries(userId: number, limit = 10) {
  const { data, error } = await supabase
    .from('brain')
    .select('id, content, category, project_tag, created_at, is_encrypted')
    .eq('user_id', userId)
    .neq('category', 'noise')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Erro ao buscar brain: ${error.message}`);

  return (data ?? []).map(row => ({
    ...row,
    content: row.is_encrypted ? decrypt(row.content) : row.content
  }));
}

export async function resolveBrainEntry(entryId: string) {
  const { error } = await supabase
    .from('brain')
    .update({ is_resolved: true, context_status: 'Concluído' })
    .eq('id', entryId);

  if (error) throw new Error(`Erro ao resolver nota do brain: ${error.message}`);
  return true;
}