// lib/services/reminders.service.ts

import { supabase } from '@/lib/jarvis';
import { scheduleReminderOnQStash, cancelReminderOnQStash, frequencyToCron } from '@/lib/qstash';

export interface ReminderPayload {
  title: string;
  type?: 'temporary' | 'recurring' | 'location';
  scheduled_time?: string | null;
  delay_minutes?: number;
  frequency?: string | null;
}

// ─── 1. CONSULTAR ─────────────────────────────────────────────────────────────
export async function coreConsultarLembretes(userId: number): Promise<string> {
  const { data, error } = await supabase
    .from('reminders')
    .select('title, scheduled_time, frequency, type')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .gte('scheduled_time', new Date().toISOString())
    .order('scheduled_time', { ascending: true })
    .limit(20);

  if (error) throw new Error(`Falha ao buscar lembretes: ${error.message}`);
  if (!data || data.length === 0) return 'Nenhum lembrete pendente.';

  return data.map(r => {
    const hora = new Date(r.scheduled_time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const freq = r.frequency ? ` (${r.frequency})` : '';
    return `- ${r.title} → ${hora}${freq}`;
  }).join('\n');
}

// ─── 2. CRIAR ─────────────────────────────────────────────────────────────────
export async function coreCriarLembrete(
  userId: number,
  authUserId: string,
  payload: ReminderPayload
): Promise<{ title: string; scheduled_time: string }> {
  const agora = new Date();
  let scheduled_time: string;
  let freq = payload.frequency;

  // Resolve o horário
  if (payload.delay_minutes) {
    scheduled_time = new Date(agora.getTime() + payload.delay_minutes * 60000).toISOString();
  } else if (payload.scheduled_time && payload.scheduled_time.length <= 8 && payload.scheduled_time.includes(':')) {
    // Só hora informada ex: "08:00" — resolve para hoje ou amanhã no fuso BR
    const [h, m] = payload.scheduled_time.split(':').map(Number);
    const dataBR = new Intl.DateTimeFormat('fr-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
    const target = new Date(`${dataBR}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-03:00`);
    if (target.getTime() <= agora.getTime()) target.setDate(target.getDate() + 1);
    scheduled_time = target.toISOString();
  } else if (payload.scheduled_time?.endsWith('Z')) {
    // IA enviou UTC por vício — reinterpreta como BR
    scheduled_time = new Date(payload.scheduled_time.replace('Z', '-03:00')).toISOString();
  } else if (payload.scheduled_time) {
    scheduled_time = new Date(payload.scheduled_time).toISOString();
    if (isNaN(new Date(scheduled_time).getTime())) throw new Error(`Data inválida: ${payload.scheduled_time}`);
  } else {
    // Fallback: 5 minutos
    scheduled_time = new Date(agora.getTime() + 5 * 60000).toISOString();
  }

  if (freq?.toLowerCase().includes('útil')) freq = 'weekdays';

  // Persiste no banco
  const { data: reminder, error } = await supabase
    .from('reminders')
    .insert({
      user_id: userId,
      title: payload.title,
      type: payload.type ?? (freq ? 'recurring' : 'temporary'),
      frequency: freq ?? null,
      scheduled_time,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) throw new Error(`Falha no banco: ${error.message}`);

  // Agenda no QStash
  const cron = freq ? frequencyToCron(freq, scheduled_time) : null;
  const qstashId = await scheduleReminderOnQStash({
    reminderId: String(reminder.id),
    userId: String(userId),
    authUserId,
    message: payload.title,
    scheduledTime: scheduled_time,
    cron,
  });

  if (qstashId) {
    await supabase.from('reminders').update({ qstash_message_id: qstashId }).eq('id', reminder.id);
  }

  return { title: payload.title, scheduled_time };
}

// ─── 3. CANCELAR ──────────────────────────────────────────────────────────────
export async function coreCancelarLembrete(userId: number, query: string): Promise<string> {
  const { data: reminder, error } = await supabase
    .from('reminders')
    .select('id, title, qstash_message_id')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .ilike('title', `%${query}%`)
    .maybeSingle();

  if (error) throw new Error(`Falha na busca: ${error.message}`);
  if (!reminder) return `Nenhum lembrete encontrado com "${query}".`;

  if (reminder.qstash_message_id) await cancelReminderOnQStash(reminder.qstash_message_id);

  await supabase.from('reminders').update({ status: 'cancelled' }).eq('id', reminder.id);

  return reminder.title;
}