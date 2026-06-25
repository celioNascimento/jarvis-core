// lib/services/brain.service.ts
//
// V3 — Janela de contexto no embedding:
//   O vetor semântico é gerado com a mensagem atual + último turno do assistente,
//   eliminando a colisão semântica em mensagens curtas ou ambíguas.
//   O conteúdo salvo no banco continua sendo só a mensagem do usuário (imutável).

import { supabase } from '@/lib/jarvis';
import { generateEmbedding } from '@/lib/memory/generate-embedding';
import { encrypt, decrypt, hashBlindIndex } from '@/lib/crypto-utils';
import { invalidateContextField } from '@/lib/services/context-cache';

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface BrainInsertInput {
  userId: number;
  content: string;
  lastAssistantTurn?: string | null; // ← NOVO: turno anterior para ancorar o embedding
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
 * Monta o texto de entrada para o embedding.
 * Se houver turno anterior do assistente, concatena antes da mensagem atual.
 * Isso ancora o vetor no contexto correto — elimina colisão semântica em
 * mensagens curtas como "sei lá" ou "a ideia do fine tuning no prompt".
 */
function buildEmbeddingInput(content: string, lastAssistantTurn: string | null | undefined): string {
  if (!lastAssistantTurn) return content;

  // Limita o turno anterior a 300 chars para não inflar o vetor
  const truncatedContext = lastAssistantTurn.trim().substring(0, 300);
  return `[contexto anterior]: ${truncatedContext}\n[mensagem atual]: ${content}`;
}

/**
 * Gera embedding com timeout de 4s.
 * Se falhar ou exceder o tempo, retorna null — a inserção continua sem vetor.
 */
async function safeGenerateEmbedding(embeddingInput: string): Promise<number[] | null> {
  try {
    const result = await Promise.race([
      generateEmbedding(embeddingInput),
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
    lastAssistantTurn,
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

  // 1. Monta input do embedding com janela de contexto
  const embeddingInput = buildEmbeddingInput(content, lastAssistantTurn);
  const hasContext = !!lastAssistantTurn;
  console.log(`[BrainService] 1. Embedding input: ${hasContext ? '✓ com contexto anterior' : '⚠ sem contexto (primeira mensagem)'} | ${embeddingInput.length} chars`);

  // 2. Gera embedding (com fallback gracioso — não bloqueia a inserção)
  const embedding = await safeGenerateEmbedding(embeddingInput);
  console.log('[BrainService] 2. Embedding:', embedding ? `✅ vetor de ${embedding.length} dims` : '⚠️ null (inserindo sem vetor)');

  // 3. Criptografia — salva só o conteúdo original do usuário (não o input do embedding)
  console.log('[BrainService] 3. Criptografando conteúdo...');
  let encryptedContent: string;
  try {
    encryptedContent = encrypt(content);
    console.log('[BrainService] 3. ✅ Conteúdo cifrado com sucesso.');
  } catch (e) {
    console.error('[BrainService] 3. ❌ Falha na criptografia:', e);
    throw new Error(`Falha ao criptografar conteúdo: ${(e as Error).message}`);
  }

  // 4. Blind index
  console.log('[BrainService] 4. Montando índice cego...');
  const rawTags = [...tags, category, projectTag];
  const blindTags = rawTags.map((tag) => hashBlindIndex(tag));
  console.log('[BrainService] 4. ✅ blindTags:', blindTags.length, 'entradas');

  // Criptografa ai_reply dentro do metadata se existir
  const safeMetadata = { ...metadata };
  if (safeMetadata.ai_reply && typeof safeMetadata.ai_reply === 'string') {
    safeMetadata.ai_reply = encrypt(safeMetadata.ai_reply);
  }

  // 5. Insert no Supabase
  console.log('[BrainService] 5. Enviando para Supabase...');
  const { data, error } = await supabase
    .from('brain')
    .insert({
      user_id: userId,
      content: encryptedContent,       // conteúdo original — não o input do embedding
      is_encrypted: true,
      blind_tags: blindTags,
      embedding: embedding ?? null,    // vetor gerado com contexto
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

  // 6. Invalida o cache de histórico para que o próximo turno leia a entrada nova
  console.log('[BrainService] 6. Invalidando cache history para userId:', userId);
  await invalidateContextField(userId, 'history').catch((e) =>
    console.warn('[BrainService] ⚠️ Falha ao invalidar cache history (não crítico):', e)
  );
  console.log('[BrainService] 6. ✅ Cache history invalidado.');

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
