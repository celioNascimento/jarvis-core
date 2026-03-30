// lib/chat/embedding-cache.ts
import { generateEmbedding } from '@/lib/jarvis';

const embeddingCache = new Map<string, number[]>();

export async function getCachedEmbedding(text: string): Promise<number[]> {
  if (embeddingCache.has(text)) return embeddingCache.get(text)!;
  const embedding = await generateEmbedding(text);
  embeddingCache.set(text, embedding);
  return embedding;
}