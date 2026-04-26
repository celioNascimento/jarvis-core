import { getCachedEmbedding } from './embedding-cache';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

function chunkL3(l3: string): string[] {
  const bySection = l3.split(/(?=^##\s)/m).map(s => s.trim()).filter(s => s.length > 80);
  if (bySection.length >= 3) return bySection;

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

// Filtragem léxica rápida antes de gerar embeddings
function lexicalFilter(chunks: string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (words.length === 0) return chunks.slice(0, 3);

  return chunks.filter(chunk => {
    const lower = chunk.toLowerCase();
    return words.some(w => lower.includes(w));
  });
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

// Roda em background — salva chunks sem embedding no Redis
async function warmL3Cache(userId: string, l3Full: string): Promise<void> {
  try {
    const chunks = chunkL3(l3Full);
    // Salva só os textos por 24h — embeddings gerados sob demanda
    await redis.set(`l3_chunks_text_${userId}`, chunks, { ex: 86400 });
    console.log(`[L3] Cache aquecido: ${chunks.length} chunks para user ${userId}`);
  } catch (e) {
    console.warn('[L3] Falha ao aquecer cache:', e);
  }
}

export async function getSemanticL3(
  userId: string,
  l3Full: string,
  queryEmbedding: number[],
  query: string,
  maxChars = 1200,
  threshold = 0.25
): Promise<string> {
  if (!l3Full || l3Full === 'Sem dossiê ainda.' || !queryEmbedding.length) return '';

  const textCacheKey = `l3_chunks_text_${userId}`;

  // Tenta buscar chunks do cache
  let chunks = await redis.get<string[]>(textCacheKey);

  if (!chunks) {
    // Cache miss: usa L3 truncado agora e aquece cache em background
    console.log(`[L3] Cache miss — retornando L3 truncado, aquecendo em background`);
    void warmL3Cache(userId, l3Full);
    // Retorna fallback simples truncado
    return l3Full.slice(0, maxChars);
  }

  // Filtragem léxica — só chunks com palavras da query
  const candidates = lexicalFilter(chunks, query);

  if (candidates.length === 0) return '';

  // Gera embedding só dos candidatos (1-3 chunks no máximo)
  const topCandidates = candidates.slice(0, 3);
  const embeddings = await Promise.all(
    topCandidates.map(c => getCachedEmbedding(c).catch(() => null))
  );

  const scored = topCandidates
    .map((text, i) => ({
      text,
      score: embeddings[i] ? cosineSimilarity(queryEmbedding, embeddings[i]!) : 0,
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
