// lib/chat/diary.ts (acréscimo)
import { supabase } from '@/lib/jarvis';

const moodCache = new Map<string, { value: number; ttl: number }>();
const MOOD_CACHE_TTL = 30 * 60 * 1000; // 30 minutos

/**
 * Retorna um fator de ajuste emocional baseado no mood dos últimos 3 dias.
 * Se mood <= 2 → 0.2; mood == 3 → 0.1; senão 0.
 */
export async function getRecentMoodAdjustment(userId: string): Promise<number> {
  const key = `mood:${userId}`;
  const cached = moodCache.get(key);
  if (cached && cached.ttl > Date.now()) {
    return cached.value;
  }

  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const { data, error } = await supabase
    .from('diary')
    .select('mood, date')
    .eq('user_id', userId)
    .gte('date', threeDaysAgo.toISOString().split('T')[0])
    .order('date', { ascending: false });

  if (error || !data || data.length === 0) {
    moodCache.set(key, { value: 0, ttl: Date.now() + MOOD_CACHE_TTL });
    return 0;
  }

  const latestMood = data[0].mood;
  let adjustment = 0;
  if (latestMood <= 2) adjustment = 0.2;
  else if (latestMood === 3) adjustment = 0.1;

  moodCache.set(key, { value: adjustment, ttl: Date.now() + MOOD_CACHE_TTL });
  return adjustment;
}