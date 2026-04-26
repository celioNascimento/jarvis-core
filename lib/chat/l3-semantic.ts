import { getCachedEmbedding } from './embedding-cache';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

function chunkL3(l3: string): string[] {
  // Agrupa por seção semântica (## headers) ou blocos de 600 chars
  const bySection = l3.split(/(?=^##\s)/m).map(s => s.trim()).filter(s => s.length > 80);
  
  if (bySection.length >= 3) return bySection;

  // Fallback: agrupa linhas em blocos de ~600 chars
  const lines = l3.split('\n').filter(l => l.trim().length > 0);
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    if (current.length + line.length > 600 && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim().length > 80) chunks.push(current.trim());

  return chunks;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function getSemanticL3(
  userId: string,
  l3Full: string,
  queryEmbedding: number[],
  maxChars = 1200,
  threshold = 0.3
): Promise<string> {
  if (!l3Full || l3Full === 'Sem dossiê ainda.' || !queryEmbedding.length) {
    return '';
  }

  const cacheKey = `l3_chunks_${userId}`;

  let chunksWithEmbeddings = await redis.get<Array<{ text: string; emb: number[] }>>(cacheKey);

  if (!chunksWithEmbeddings) {
    const chunks = chunkL3(l3Full);

    const embeddings = await Promise.all(
      chunks.map(chunk => getCachedEmbedding(chunk).catch(() => null))
    );

    chunksWithEmbeddings = chunks
      .map((text, i) => ({ text, emb: embeddings[i]! }))
      .filter(c => c.emb !== null);

    await redis.set(cacheKey, chunksWithEmbeddings, { ex: 3600 });
  }

  const scored = chunksWithEmbeddings
    .map(c => ({
      text: c.text,
      score: cosineSimilarity(queryEmbedding, c.emb),
    }))
    .filter(c => c.score >= threshold)
    .sort((a, b) => b.score - a.score);

  let result = '';
  for (const chunk of scored) {
    if (result.length + chunk.text.length > maxChars) break;
    result += chunk.text + '\n\n';
  }

  return result.trim();
}
