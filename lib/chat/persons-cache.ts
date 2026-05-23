// lib/chat/persons-cache.ts
// Cache migrado para Redis via ContextCache — Map em serverless não persiste

import { ContextCache } from '@/lib/services/context-cache';
import { supabase } from '@/lib/jarvis';

interface Person {
  name: string;
  emotional_weight: number | null;
  type?: string;
}

export async function getCachedPersons(userId: string): Promise<Person[]> {
  const cache = new ContextCache(Number(userId));

  const cached = await cache.get<Person[]>('persons');
  if (cached) return cached;

  try {
    const { data, error } = await supabase
      .from('persons')
      .select('name, emotional_weight, type')
      .eq('user_id', userId);

    if (error) throw error;

    const persons: Person[] = data || [];
    await cache.set('persons', persons);
    return persons;
  } catch (err) {
    console.warn('[PersonsCache] Falha ao buscar persons:', err);
    return [];
  }
}

export async function invalidatePersonsCache(userId: string): Promise<void> {
  const cache = new ContextCache(Number(userId));
  await cache.invalidate('persons');
}