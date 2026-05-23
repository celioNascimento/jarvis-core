// lib/chat/diary.ts
import { supabase } from '@/lib/jarvis';
import { ContextCache } from '@/lib/services/context-cache';

export async function getRecentMoodAdjustment(userId: string): Promise<number> {
  const cache = new ContextCache(Number(userId));
  const CACHE_KEY = 'diary';

  const cached = await cache.get<{ moodAdjustment: number }>(CACHE_KEY);
  if (cached?.moodAdjustment !== undefined) return cached.moodAdjustment;

  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const { data, error } = await supabase
    .from('diary')
    .select('mood, date')
    .eq('user_id', userId)
    .gte('date', threeDaysAgo.toISOString().split('T')[0])
    .order('date', { ascending: false });

  let adjustment = 0;
  if (!error && data?.length) {
    const latestMood = data[0].mood;
    if (latestMood <= 2) adjustment = 0.2;
    else if (latestMood === 3) adjustment = 0.1;
  }

  await cache.set(CACHE_KEY, { moodAdjustment: adjustment });
  return adjustment;
}