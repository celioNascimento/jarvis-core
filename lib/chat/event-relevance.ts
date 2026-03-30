// lib/chat/event-relevance.ts
import { supabase } from '@/lib/jarvis';
import { assertNumericUserId } from './guards';

export async function updateEventRelevance(userId: string) {
  assertNumericUserId(userId, 'updateEventRelevance');
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  const { data: events } = await supabase
    .from('events')
    .select('id, title, event_date, decay_type, relevance_score')
    .eq('user_id', userId);

  if (!events) return;

  const updates: { id: string; relevance_score: number }[] = [];
  for (const ev of events) {
    const eventDate = new Date(ev.event_date);
    eventDate.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil(
      (eventDate.getTime() - hoje.getTime()) / (1000 * 3600 * 24)
    );

    let newScore = 0;
    switch (ev.decay_type) {
      case 'recurring_annual':
        if (diffDays < -30) newScore = 0;
        else if (diffDays <= 0) newScore = 0.9 + (diffDays === 0 ? 0.1 : 0);
        else if (diffDays <= 30) newScore = 0.3 + 0.6 * (1 - diffDays / 30);
        else newScore = 0;
        break;
      case 'deadline':
        if (diffDays < -7) newScore = 0;
        else if (diffDays <= 0) newScore = 0.9 + (diffDays === 0 ? 0.1 : 0);
        else if (diffDays <= 7) newScore = 0.3 + 0.6 * (1 - diffDays / 7);
        else newScore = 0;
        break;
      case 'one_time':
        if (diffDays < -14) newScore = 0;
        else if (diffDays <= 0) newScore = 0.9 + (diffDays === 0 ? 0.1 : 0);
        else if (diffDays <= 14) newScore = 0.2 + 0.7 * (1 - diffDays / 14);
        else newScore = 0;
        break;
      default:
        if (diffDays < 0)
          newScore = Math.max(0, (ev.relevance_score || 0) * 0.95);
        else newScore = ev.relevance_score || 0;
    }

    newScore = Math.min(0.95, Math.max(0, newScore));
    if (Math.abs(newScore - (ev.relevance_score || 0)) > 0.01) {
      updates.push({ id: ev.id, relevance_score: newScore });
    }
  }

  if (updates.length) {
    for (const upd of updates) {
      await supabase
        .from('events')
        .update({ relevance_score: upd.relevance_score })
        .eq('id', upd.id);
    }
    console.log(`[Eventos] Relevâncias atualizadas: ${updates.length}`);
  }
}

export async function ensureMemoryHealth(userId: string) {
  assertNumericUserId(userId, 'ensureMemoryHealth');
  try {
    await updateEventRelevance(userId);

    const { data: topics } = await supabase
      .from('topic_index')
      .select('id, weight')
      .eq('user_id', userId)
      .lt(
        'last_mentioned',
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      );

    if (topics?.length) {
      for (const topic of topics) {
        const newWeight = (topic.weight || 0) * 0.95;
        await supabase
          .from('topic_index')
          .update({ weight: newWeight })
          .eq('id', topic.id);
      }
      console.log(`[Health] Decaimento L4: ${topics.length} tópicos`);
    }
  } catch (e) {
    console.error('[Health] Erro no health check:', e);
  }
}