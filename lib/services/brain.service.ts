// lib/services/brain.service.ts
// Fonte única da verdade para a tabela jarvis.brain (Com Criptografia e Índice Cego)

import { supabase } from '@/lib/jarvis';
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
  tags?: string[]; // Tags extras para o Índice Cego
}

/**
 * Insere um novo desabafo, log ou nota no Brain do usuário.
 * O conteúdo é criptografado em AES-256-GCM antes de ir para o banco.
 */
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

  // 1. Gera o embedding a partir do texto puro
  const embedding = await generateEmbedding(content);

  // 2. Criptografa o conteúdo íntimo
  const encryptedContent = encrypt(content);

  // 3. Monta o Índice Cego (Hash) com as tags, categoria e projeto
  const rawTags = [...tags, category, projectTag];
  const blindTags = rawTags.map(tag => hashBlindIndex(tag));

  const { data, error } = await supabase
    .from('brain')
    .insert({
      user_id: userId,
      content: encryptedContent, // Dado ininteligível
      is_encrypted: true,        // Flag ativada
      blind_tags: blindTags,     // Array de hashes para busca segura
      embedding,                 // Vetor semântico
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

/**
 * Busca as entradas recentes do Brain de um usuário.
 * Descriptografa automaticamente o conteúdo se a flag estiver ativada.
 */
export async function getRecentBrainEntries(userId: number, limit = 10) {
  const { data, error } = await supabase
    .from('brain')
    .select('id, content, category, project_tag, created_at, is_encrypted')
    .eq('user_id', userId)
    .neq('category', 'noise')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Erro ao buscar brain: ${error.message}`);

  // Retorna os dados com o texto descriptografado para o Lev ler
  return (data ?? []).map(row => ({
    ...row,
    content: row.is_encrypted ? decrypt(row.content) : row.content
  }));
}

/**
 * Marca uma entrada do brain como resolvida ou arquivada.
 */
export async function resolveBrainEntry(entryId: string) {
  const { error } = await supabase
    .from('brain')
    .update({ is_resolved: true, context_status: 'Concluído' })
    .eq('id', entryId);

  if (error) throw new Error(`Erro ao resolver nota do brain: ${error.message}`);
  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function generateEmbedding(text: string): Promise<number[]> {
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