import { getCachedEmbedding } from './embedding-cache';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

function chunkL3(l3: string): string[] {
  // Divide por blocos semânticos naturais (duplo newline ou marcadores)
  const raw = l3
    .split(/\n{2,}|(?=##\s)|(?=\n-\s)/)
    .map(s => s.trim())
    .filter(s => s.length > 40); // ignora fragmentos triviais

  // Se não fragmentou bem, faz por tamanho fixo
  if (raw.length <= 1) {
    const chunks: string[] = [];
    for (let i = 0; i < l3.length; i += 400) {
      chunks.push(l3.slice(i, i + 400));
    }
    return chunks;
  }

  return raw;
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

  // Tenta buscar chunks + embeddings do cache
  let chunksWithEmbeddings = await redis.get<Array<{ text: string; emb: number[] }>>(cacheKey);

  if (!chunksWithEmbeddings) {
    const chunks = chunkL3(l3Full);

    // Gera embeddings em paralelo
    const embeddings = await Promise.all(
      chunks.map(chunk => getCachedEmbedding(chunk).catch(() => null))
    );

    chunksWithEmbeddings = chunks
      .map((text, i) => ({ text, emb: embeddings[i]! }))
      .filter(c => c.emb !== null);

    // Cache por 1 hora — o L3 muda pouco
    await redis.set(cacheKey, chunksWithEmbeddings, { ex: 3600 });
  }

  // Calcula similaridade de cada chunk com a query
  const scored = chunksWithEmbeddings
    .map(c => ({
      text: c.text,
      score: cosineSimilarity(queryEmbedding, c.emb),
    }))
    .filter(c => c.score >= threshold)
    .sort((a, b) => b.score - a.score);

  // Monta resultado respeitando maxChars
  let result = '';
  for (const chunk of scored) {
    if (result.length + chunk.text.length > maxChars) break;
    result += chunk.text + '\n\n';
  }

  return result.trim();
}
