// lib/chat/topic-index.ts
import { supabase } from '@/lib/jarvis';
import type { ContextType } from './context-classifier';

/**
 * Atualiza o índice de tópicos de forma eficiente:
 * - Uma única SELECT para buscar todos os tópicos existentes
 * - Cálculo em memória da EMA
 * - Um único UPSERT para todos os tópicos
 */
export async function updateTopicIndex(
  userId: string,
  contexts: ContextType[],
  message: string,
  emotionalScore?: number
): Promise<void> {
  if (!contexts.length) return;

  const now = new Date().toISOString();

  // FIX #1: Adicionado .schema('jarvis') — tabela está em jarvis.topic_index
  const { data: existing } = await supabase
    .schema('jarvis')
    .from('topic_index')
    .select('topic, weight, emotional_dimension, count')
    .eq('user_id', userId)
    .in('topic', contexts);

  const existingMap = new Map((existing || []).map(r => [r.topic, r]));

  const upsertRows = contexts.map(topic => {
    const rec = existingMap.get(topic);
    if (rec) {
      const newWeight = (rec.weight || 0) * 0.7 + 0.3;
      let newEmotionalDim = rec.emotional_dimension || 0;
      if (emotionalScore !== undefined) {
        newEmotionalDim = rec.emotional_dimension * 0.8 + emotionalScore * 0.2;
      }
      return {
        user_id: userId,
        topic,
        weight: Math.min(1.0, newWeight),
        emotional_dimension: Math.min(1.0, Math.max(0, newEmotionalDim)),
        count: (rec.count || 0) + 1,
        last_mentioned: now,
      };
    } else {
      return {
        user_id: userId,
        topic,
        weight: 1.0,
        emotional_dimension: emotionalScore ?? 0.0,
        count: 1,
        last_mentioned: now,
      };
    }
  });

  // FIX #1: .schema('jarvis')
  // FIX #2: onConflict sem espaço após a vírgula (PostgREST é sensível a isso)
  await supabase
    .schema('jarvis')
    .from('topic_index')
    .upsert(upsertRows, { onConflict: 'user_id,topic' });
}

export async function getRelatedTopics(userId: string, currentContext: string): Promise<string> {
  // FIX #1: .schema('jarvis')
  const { data: related } = await supabase
    .schema('jarvis')
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
  // FIX #1: .schema('jarvis')
  const { data: recentTopics } = await supabase
    .schema('jarvis')
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
