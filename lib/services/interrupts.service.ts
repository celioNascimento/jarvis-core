// lib/services/interrupts.service.ts
import { supabase } from '@/lib/jarvis';
import { getGoogleContext } from '../google';

export async function getProactiveEvents(userId: string) {
  const hoje = new Date();
  const seteDiasDepois = new Date();
  seteDiasDepois.setDate(hoje.getDate() + 7);

  const { data: events } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .filter('last_notified_year', 'neq', hoje.getFullYear());

  if (!events) return [];

  return events.filter(event => {
    const d = new Date(event.event_date);
    const isHoje = d.getDate() === hoje.getDate() && d.getMonth() === hoje.getMonth();
    const isSeteDias = d.getDate() === seteDiasDepois.getDate() && d.getMonth() === seteDiasDepois.getMonth();
    return isHoje || isSeteDias;
  });
}

export async function checkSystemInterrupts(userId: string) {
  try {
    const agenda = await getGoogleContext();
    const temFolga = agenda.toLowerCase().includes("feriado") || agenda.toLowerCase().includes("folga");

    return {
      shouldPauseMorningRoutine: temFolga,
      reason: temFolga ? "Feriado/Folga detectado" : null
    };
  } catch (e) {
    console.error("[Interrupts] Erro:", e);
    return { shouldPauseMorningRoutine: false, reason: null };
  }
}
