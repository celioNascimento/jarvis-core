// lib/memory/embedding-cache.ts — V3.0
// Responsabilidade única: cache de embeddings via Redis.
//
// ANTES: usava supabase.from('config') — causava GET /config duplo no log
// AGORA: usa Redis com TTL de 7 dias
//
// Não gera embeddings — delega para generate-embedding.ts.
// Não conhece userId, contextos ou pipeline — só texto → vetor cacheado.

import { Redis } from '@upstash/redis';
import { generateEmbedding } from './generate-embedding';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const EMBEDDING_TTL = 7 * 24 * 60 * 60; // 7 dias — embeddings são estáveis
const KEY_PREFIX = 'emb:';

function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function cacheKey(text: string): string {
  return `${KEY_PREFIX}${hashCode(text)}`;
}

/**
 * Retorna embedding do cache Redis ou gera um novo.
 * Salva no Redis em background após geração.
 * Retorna null em caso de falha — nunca lança exceção.
 */
export async function getCachedEmbedding(text: string): Promise<number[] | null> {
  const key = cacheKey(text);

  try {
    // 1. Tenta Redis
    const cached = await redis.get<number[]>(key);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      console.log('[Embedding Cache] HIT:', key);
      return cached;
    }

    // 2. Cache miss — gera novo
    console.log('[Embedding Cache] MISS, gerando novo:', key);
    const embedding = await generateEmbedding(text);

    if (embedding?.length) {
      // Salva no Redis em background — não bloqueia o pipeline
      redis.set(key, embedding, { ex: EMBEDDING_TTL })
        .then(() => {
          console.log('[Embedding Cache] Salvo (Background):', key, 'dimensões:', embedding.length);
        })
        .catch(e => {
          console.warn('[Embedding Cache] Falha ao salvar no Redis:', e?.message);
        });
    }

    return embedding;
  } catch (e) {
    console.error('[Embedding Cache] Erro crítico:', e);
    // Fallback: tenta gerar sem cache
    return generateEmbedding(text).catch(() => null);
  }
}