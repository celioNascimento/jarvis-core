// lib/chat/topic-index.ts
import { supabase } from '@/lib/jarvis';
import type { ContextType } from './context-classifier';

export async function updateTopicIndex(
  userId: string,
  contexts: string[],
  messageText: string
) {
  if (!contexts.length) return;
  const words = messageText.toLowerCase().split(/\s+/);
  const keyTerms = words.filter((w) => w.length > 3 && !/[0-9]/.test(w)).slice(0, 5);

  for (const ctx of contexts) {
    const { data: existing } = await supabase
      .from('topic_index')
      .select('weight')
      .eq('user_id', userId)
      .eq('topic', ctx)
      .maybeSingle();

    const newWeight = (existing?.weight || 0) + 0.1;
    await supabase.from('topic_index').upsert(
      {
        user_id: userId,
        topic: ctx,
        weight: newWeight,
        last_mentioned: new Date().toISOString(),
        related_terms: keyTerms,
      },
      { onConflict: 'user_id,topic' }
    );
  }
}

export async function getRelatedTopics(userId: string, currentContext: string): Promise<string> {
  const { data: related } = await supabase
    .from('topic_index')
    .select('topic, weight')
    .eq('user_id', userId)
    .neq('topic', currentContext)
    .order('weight', { ascending: false })
    .limit(3);

  if (!related?.length) return '';
  return `\n[TÓPICOS RELACIONADOS]\n${related
    .map((t: any) => `- ${t.topic} (peso: ${Math.round((t.weight || 0) * 100)}%)`)
    .join('\n')}`;
}

export async function detectTopicShiftWithL4(
  userId: string,
  currentContexts: ContextType[]
): Promise<boolean> {
  const { data: recentTopics } = await supabase
    .from('topic_index')
    .select('topic, weight')
    .eq('user_id', userId)
    .order('last_mentioned', { ascending: false })
    .limit(5);

  if (!recentTopics?.length) return false;

  const hasCurrentTopic = currentContexts.some((ctx) =>
    recentTopics.some((t: any) => t.topic === ctx && (t.weight || 0) >= 0.3)
  );

  return !hasCurrentTopic && !currentContexts.includes('casual');
}