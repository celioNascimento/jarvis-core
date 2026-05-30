// lib/services/brain.service.ts
//
// V2 — Correções críticas:
//   1. generateEmbedding com timeout e fallback gracioso (não bloqueia inserção)
//   2. invalidateContextField após inserção confirmada (cache history atualizado)
//   3. Logging detalhado em cada etapa para rastrear onde falha
//   (schema jarvis já está configurado no cliente supabase de @/lib/jarvis)

import { supabase } from '@/lib/jarvis';
import { generateEmbedding } from '@/lib/memory/generate-embedding';
import { encrypt, decrypt, hashBlindIndex } from '@/lib/crypto-utils';
import { invalidateContextField } from '@/lib/services/context-cache';

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface BrainInsertInput {
  userId: number;
  content: string;
  projectTag?: string;
  category?:
  | 'Nota'
  | 'Dúvida'
  | 'Log_Tecnico'
  | 'Ideia_Estacionada'
  | 'Documentacao'
  | 'info'
  | 'noise'
  | 'archived';
  sessionId?: string;
  emotionalScore?: number;
  priorityScore?: number;
  tags?: string[];
  metadata?: Record<string, any>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Gera embedding com timeout de 4s.
 * Se falhar ou exceder o tempo, retorna null — a inserção continua sem vetor.
 * Isso evita que uma falha no modelo de embedding bloqueie o salvamento do brain.
 */
async function safeGenerateEmbedding(content: string): Promise<number[] | null> {
  try {
    const result = await Promise.race([
      generateEmbedding(content),
      new Promise<null>((resolve) =>
        setTimeout(() => {
          console.warn('[BrainService] ⚠️ Timeout no generateEmbedding (4s). Inserindo sem vetor.');
          resolve(null);
        }, 4000)
      ),
    ]);
    return result;
  } catch (e) {
    console.error('[BrainService] ❌ Erro em generateEmbedding:', e);
    return null;
  }
}

// ─── Insert ───────────────────────────────────────────────────────────────────

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
    metadata = {},
  } = input;

  console.log('[BrainService] ── Iniciando inserção ──────────────────────────');
  console.log('[BrainService] userId:', userId, '| category:', category, '| sessionId:', sessionId);

  // 1. Embedding (com fallback gracioso — não bloqueia a inserção)
  console.log('[BrainService] 1. Gerando embedding...');
  const embedding = await safeGenerateEmbedding(content);
  console.log('[BrainService] 1. Embedding:', embedding ? `✅ vetor de ${embedding.length} dims` : '⚠️ null (inserindo sem vetor)');

  // 2. Criptografia
  console.log('[BrainService] 2. Criptografando conteúdo...');
  let encryptedContent: string;
  try {
    encryptedContent = encrypt(content);
    console.log('[BrainService] 2. ✅ Conteúdo cifrado com sucesso.');
  } catch (e) {
    console.error('[BrainService] 2. ❌ Falha na criptografia:', e);
    throw new Error(`Falha ao criptografar conteúdo: ${(e as Error).message}`);
  }

  // 3. Blind index
  console.log('[BrainService] 3. Montando índice cego...');
  const rawTags = [...tags, category, projectTag];
  const blindTags = rawTags.map((tag) => hashBlindIndex(tag));
  console.log('[BrainService] 3. ✅ blindTags:', blindTags.length, 'entradas');

  // Criptografa ai_reply dentro do metadata se existir
  const safeMetadata = { ...metadata };
  if (safeMetadata.ai_reply && typeof safeMetadata.ai_reply === 'string') {
    safeMetadata.ai_reply = encrypt(safeMetadata.ai_reply);
  }

  // 4. Insert no Supabase
  console.log('[BrainService] 4. Enviando para Supabase...');
  const { data, error } = await supabase
    .from('brain')
    .insert({
      user_id: userId,
      content: encryptedContent,
      is_encrypted: true,
      blind_tags: blindTags,
      embedding: embedding ?? null,
      project_tag: projectTag,
      category,
      session_id: sessionId ?? null,
      emotional_score: emotionalScore ?? null,
      priority_score: priorityScore,
      metadata: safeMetadata,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[BrainService] ❌ ERRO FATAL DO SUPABASE:', error);
    throw new Error(`Falha ao inserir no brain: ${error.message}`);
  }

  console.log('[BrainService] ✅ Inserção confirmada. ID:', data?.id);

  // 5. Invalida o cache de histórico para que o próximo turno leia a entrada nova
  console.log('[BrainService] 5. Invalidando cache history para userId:', userId);
  await invalidateContextField(userId, 'history').catch((e) =>
    console.warn('[BrainService] ⚠️ Falha ao invalidar cache history (não crítico):', e)
  );
  console.log('[BrainService] 5. ✅ Cache history invalidado.');

  console.log('[BrainService] ── Inserção finalizada ────────────────────────');
  return data;
}

// ─── Leitura ──────────────────────────────────────────────────────────────────

export async function getRecentBrainEntries(userId: number, limit = 10) {
  const { data, error } = await supabase
    .from('brain')
    .select('id, content, category, project_tag, created_at, is_encrypted')
    .eq('user_id', userId)
    .neq('category', 'noise')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Erro ao buscar brain: ${error.message}`);

  return (data ?? []).map((row) => ({
    ...row,
    content: row.is_encrypted ? decrypt(row.content) : row.content,
  }));
}

// ─── Resolução ────────────────────────────────────────────────────────────────

export async function resolveBrainEntry(entryId: string) {
  const { error } = await supabase
    .from('brain')
    .update({ is_resolved: true, context_status: 'Concluído' })
    .eq('id', entryId);

  if (error) throw new Error(`Erro ao resolver nota do brain: ${error.message}`);
  return true;
}