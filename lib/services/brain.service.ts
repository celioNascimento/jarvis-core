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
  metadata?: Record<string, any>; // ← ADICIONADO AQUI
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
    metadata = {}
  } = input;

  console.log('[BrainService] 1. Gerando embedding...');
  const embedding = await generateEmbedding(content);

  console.log('[BrainService] 2. Criptografando conteúdo...');
  const encryptedContent = encrypt(content);

  console.log('[BrainService] 3. Montando Índice Cego...');
  const rawTags = [...tags, category, projectTag];
  const blindTags = rawTags.map(tag => hashBlindIndex(tag));

  console.log('[BrainService] 4. Enviando transação ao Supabase...');
  
  const { data, error } = await supabase
    .from('brain')
    .insert({
      user_id: userId,
      content: encryptedContent,
      is_encrypted: true,
      blind_tags: blindTags,
      embedding: embedding || null,
      project_tag: projectTag,
      category,
      session_id: sessionId,
      emotional_score: emotionalScore,
      priority_score: priorityScore,
      metadata: metadata, // ← Objeto puro (Supabase serializa automaticamente para JSONB)
    })
    .select('id')
    .single();

  if (error) {
    // Esse log vermelho VAI aparecer se o banco rejeitar
    console.error('[BrainService] ❌ ERRO FATAL DO SUPABASE:', error);
    throw new Error(`Falha ao inserir no brain: ${error.message}`);
  }

  console.log('[BrainService] ✅ Inserção confirmada. ID:', data?.id);
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