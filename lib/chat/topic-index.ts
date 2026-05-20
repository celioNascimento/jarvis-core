import { supabase } from '@/lib/jarvis';
import type { ContextType } from './context-classifier';

// A função de atualização ainda precisa de banco, mas agora é async sem bloquear o chat
export async function updateTopicIndex(userId: string, contexts: ContextType[], message: string, emotionalScore?: number): Promise<void> {
  if (!contexts.length) return;
  const numericId = Number(userId);
  const now = new Date().toISOString();

  // Upsert direto via Supabase service role
  const upsertRows = contexts.map(topic => ({
    user_id: numericId,
    topic,
    label: topic,
    weight: 0.3,
    count: 1,
    last_mentioned: now
  }));

  await supabase.from('topic_index').upsert(upsertRows, { onConflict: 'user_id,topic' });
}

// Não faz consulta, usa o masterContext injetado
export function getRelatedTopics(opts: any): string {
  // Acessa o que você passou no objeto
  const related = opts.masterContext?.related_topics || [];
  
  if (!related?.length) return '';

  return `\n[TÓPICOS RELACIONADOS]\n${related
    .map((t: any) => `- ${t.topic} (peso: ${Math.round((t.weight || 0) * 100)}%)`)
    .join('\n')}`;
}