// lib/chat/ram.ts
import { supabase } from '@/lib/jarvis';
import { getCachedEmbedding } from './embedding-cache';

export const RAM_MAX_CHARS = 8000;

export function compressToSummary(history: any[]): string {
  const topics = history
    .flatMap((h: any) => (h.metadata?.contexts_detected as string[] | undefined) || [])
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(', ');
  return topics ? `[Resumo do assunto anterior: ${topics}]` : '[Contexto anterior resumido]';
}

export async function semanticRamCompression(
  history: any[],
  userId: string,
  messageText: string,
  currentEmbedding?: number[]
): Promise<string> {
  if (!history.length) return '';
  const embedding = currentEmbedding || (await getCachedEmbedding(messageText));

  const { data: relevantMemories } = (await supabase.rpc('match_memories', {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 5,
  })) as { data: any[] | null };

  if (relevantMemories?.length) {
    const semanticBlock = relevantMemories
      .filter((r: any) => !r.summary.startsWith('[CINZA]'))
      .map((r: any) => r.summary)
      .join('\n---\n');
    return `[MEMÓRIAS SEMANTICAMENTE RELEVANTES]\n${semanticBlock}`;
  }
  return '';
}

export function isMeaningfulDiaryBlock(block: string): boolean {
  if (!block) return false;
  const lower = block.toLowerCase();
  return !(
    lower.includes('nenhum') ||
    lower.includes('não encontrado') ||
    lower.includes('sem registro')
  );
}