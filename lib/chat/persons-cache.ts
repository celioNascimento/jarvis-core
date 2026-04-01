// lib/chat/persons-cache.ts
import { supabase } from '@/lib/jarvis';

interface Person {
  name: string;
  emotional_weight: number | null;
  type?: string;
}

// Cache em memória – em ambiente serverless, cada instância tem seu próprio cache.
// Para tráfego baixo/médio é aceitável; se necessário, migrar para Redis.
const cache = new Map<string, { data: Person[]; ttl: number }>();
const TTL_MS = 5 * 60 * 1000; // 5 minutos

export async function getCachedPersons(userId: string): Promise<Person[]> {
  const key = `persons:${userId}`;
  const cached = cache.get(key);
  if (cached && cached.ttl > Date.now()) {
    return cached.data;
  }

  try {
    const { data, error } = await supabase
      .from('persons')
      .select('name, emotional_weight, type')
      .eq('user_id', userId);

    if (error) throw error;

    const persons: Person[] = data || [];
    cache.set(key, { data: persons, ttl: Date.now() + TTL_MS });
    return persons;
  } catch (err) {
    console.warn('[PersonsCache] Falha ao buscar persons:', err);
    return [];
  }
}

export function invalidatePersonsCache(userId: string) {
  const key = `persons:${userId}`;
  cache.delete(key);
}