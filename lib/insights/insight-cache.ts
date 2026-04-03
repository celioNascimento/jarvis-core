// lib/insights/insight-cache.ts
// Cache simples em memória com TTL (padrão 5 minutos)

const cache = new Map<string, { value: string; expires: number }>();

export function getCachedInsight(key: string): string | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function setCachedInsight(key: string, value: string, ttlSeconds = 300) {
  cache.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}