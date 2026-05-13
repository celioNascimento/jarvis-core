// lib/tools/executors/agenda.ts
// V11.1.0 — Integrado, Completo e Resiliente ao Build (9 Exports)

import { supabase } from '@/lib/jarvis';
import { getRecentEmails, getMicrosoftCalendarContext } from '@/lib/microsoft';
import { getGoogleContext, createGoogleEvent, trashGoogleEmail } from '@/lib/google';
import { scheduleReminderOnQStash, cancelReminderOnQStash } from '@/lib/qstash';
import { getEffectiveUserId } from '@/lib/modules/relationships';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const getCronExpression = (freq: string, time: Date) => {
  const m = time.getMinutes();
  const h = time.getHours();
  switch (freq) {
    case 'daily': return `${m} ${h} * * *`;
    case 'weekdays': return `${m} ${h} * * 1-5`;
    case 'weekly': return `${m} ${h} * * ${time.getDay()}`;
    case 'monthly': return `${m} ${h} ${time.getDate()} * *`;
    default: return null;
  }
};

// ─── 1. CONSULTAR AGENDA ──────────────────────────────────────────────────────

export async function executeConsultarAgenda(
  p: { dias?: number },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const [levRes, googleRes, outlookRes] = await Promise.allSettled([
      supabase.rpc('get_calendar_context_for_jarvis', {
        p_user_id: Number(targetId),
        p_days: p.dias || 7,
      }),
      getGoogleContext().catch(() => null),
      getMicrosoftCalendarContext().catch(() => null),
    ]);

    const lev = levRes.status === 'fulfilled' && levRes.value.data
      ? levRes.value.data
      : 'Nenhum evento encontrado na Agenda Lev.';

    let result = `[AGENDA LEV]\n${lev}`;
    if (googleRes.status === 'fulfilled' && googleRes.value) result += `\n\n[GOOGLE]\n${googleRes.value}`;
    if (outlookRes.status === 'fulfilled' && outlookRes.value) result += `\n\n[OUTLOOK]\n${outlookRes.value}`;

    return result;
  } catch { return 'Erro ao consultar agenda.'; }
}

// ─── 2. SALVAR EVENTO (LEV) ───────────────────────────────────────────────────

export async function executeSalvarEvento(
  p: { title?: string; summary?: string; event_date?: string; startTime?: string; category?: string; notes?: string; reminderMinutes?: number; force?: boolean; },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const anoAtual = new Date().getFullYear();
    let rawDate = (p.event_date || p.startTime || '').trim().replace(' ', 'T');

    const anoEvento = parseInt(rawDate.substring(0, 4));
    if (anoEvento > 0 && (anoEvento < anoAtual || isNaN(anoEvento))) {
      rawDate = String(anoAtual) + rawDate.substring(4);
    }
    const withOffset = /(Z|[+-]\d{2}:\d{2})$/.test(rawDate) ? rawDate : rawDate + '-03:00';
    const startDate = new Date(withOffset);
    if (isNaN(startDate.getTime())) return 'Erro: data inválida.';

    const startISO = startDate.toISOString();
    const endISO = new Date(startDate.getTime() + 3600000).toISOString();

    if (!p.force) {
      const { data: conflitos } = await supabase.from('events').select('title, start_at')
        .eq('user_id', Number(targetId)).lt('start_at', endISO).gt('end_at', startISO);

      if (conflitos?.length) {
        const hora = new Date(conflitos[0].start_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return `[ALERTA] Você já tem "${conflitos[0].title}" às ${hora}. Confirmar assim mesmo?`;
      }
    }

    const { error } = await supabase.from('events').insert({
      user_id: Number(targetId),
      title: p.title || p.summary,
      start_at: startISO,
      end_at: endISO,
      category: p.category || 'personal',
      source: 'lev',
      reminder_minutes: [p.reminderMinutes ?? 30],
      notes: p.notes || null,
    });

    if (error) throw error;
    return `Evento "${p.title || p.summary}" salvo para ${startDate.toLocaleString('pt-BR')}.`;
  } catch (err: any) { return `Erro: ${err.message}`; }
}

// ─── 3. CRIAR EVENTO GOOGLE (EXTERNO) ─────────────────────────────────────────

export async function executeCriarEventoAgenda(
  p: { summary: string; startTime: string; reminderMinutes?: number },
  _authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    return await createGoogleEvent(p.summary, p.startTime, p.reminderMinutes || 30);
  } catch (err: any) { return `Erro no Google Calendar: ${err.message}`; }
}

// ─── 4. LISTAR EMAILS ─────────────────────────────────────────────────────────

export async function executeListarEmailsRecentes(
  p: { filtro?: string },
  _authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    return await getRecentEmails(p.filtro, 5, true);
  } catch (err: any) { return `Erro ao buscar emails: ${err.message}`; }
}

// ─── 5. EXCLUIR EMAIL ─────────────────────────────────────────────────────────

export async function executeExcluirEmail(
  p: { messageId: string },
  _authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    return await trashGoogleEmail(p.messageId);
  } catch (err: any) { return `Erro ao excluir: ${err.message}`; }
}

// ─── 6. CREATE REMINDER ───────────────────────────────────────────────────────

export async function executeCreateReminder(
  p: { title?: string; message?: string; type?: string; scheduled_time?: string; delay_minutes?: number; frequency?: string; },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const title = p.title || p.message || 'Lembrete';
    const agora = new Date();
    let freq = p.frequency;
    let scheduled_time = p.scheduled_time;

    if (freq?.toLowerCase().includes('útil')) freq = 'weekdays';

    if (scheduled_time) {
      if (scheduled_time.length <= 8 && scheduled_time.includes(':')) {
        const timeStr = scheduled_time.length <= 5 ? `${scheduled_time}:00` : scheduled_time;
        const dataRef = new Date(`${agora.toLocaleDateString('en-CA')}T${timeStr}-03:00`);
        if (dataRef.getTime() <= agora.getTime()) dataRef.setDate(dataRef.getDate() + 1);
        if (freq === 'weekdays') {
          if (dataRef.getDay() === 6) dataRef.setDate(dataRef.getDate() + 2);
          if (dataRef.getDay() === 0) dataRef.setDate(dataRef.getDate() + 1);
        }
        scheduled_time = dataRef.toISOString();
      } else {
        scheduled_time = new Date(scheduled_time.includes('Z') ? scheduled_time : `${scheduled_time}-03:00`).toISOString();
      }
    } else {
      scheduled_time = new Date(agora.getTime() + (p.delay_minutes || 5) * 60000).toISOString();
    }

    const { data: reminder, error } = await supabase.from('reminders').insert({
      user_id: Number(targetId),
      title,
      type: p.type || (freq ? 'recurring' : 'temporary'),
      frequency: freq || null,
      scheduled_time,
      status: 'pending',
      metadata: { auth_user_id: authUserId }
    }).select('id').single();

    if (error) throw error;

    const cron = freq ? getCronExpression(freq, new Date(scheduled_time)) : null;
    const qstashId = await scheduleReminderOnQStash({
      reminderId: String(reminder.id),
      userId: String(targetId),
      authUserId,
      message: title,
      scheduledTime: cron ? null : scheduled_time,
      cron
    });

    if (qstashId) await supabase.from('reminders').update({ qstash_message_id: qstashId }).eq('id', reminder.id);

    return `Lembrete "${title}" agendado para ${new Date(scheduled_time).toLocaleString('pt-BR')}${freq ? ` (${freq})` : ''}.`;
  } catch (err: any) { return `Erro: ${err.message}`; }
}

// ─── 7. CONSULTAR LEMBRETES ───────────────────────────────────────────────────

export async function executeConsultarLembretes(
  _p: any,
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { data: reminders } = await supabase.from('reminders').select('title, scheduled_time')
      .eq('user_id', Number(targetId)).eq('status', 'pending').gte('scheduled_time', new Date().toISOString()).order('scheduled_time', { ascending: true });

    if (!reminders?.length) return 'Nenhum lembrete pendente.';
    return reminders.map(r => `- ${r.title} (${new Date(r.scheduled_time).toLocaleString('pt-BR')})`).join('\n');
  } catch { return 'Erro ao buscar lembretes.'; }
}

// ─── 8. DELETAR EVENTO ────────────────────────────────────────────────────────

export async function executeDeletarEvento(p: { query: string }, authUserId: string, numericUserId: string): Promise<string> {
  const targetId = await getEffectiveUserId(authUserId, numericUserId);
  const { error } = await supabase.from('events').delete().eq('user_id', Number(targetId)).ilike('title', `%${p.query}%`);
  return error ? 'Erro ao excluir.' : `Evento "${p.query}" removido.`;
}

// ─── 9. CANCELAR LEMBRETE ──────────────────────────────────────────────────────

export async function executeCancelarLembrete(p: { query: string }, authUserId: string, numericUserId: string): Promise<string> {
  const targetId = await getEffectiveUserId(authUserId, numericUserId);
  const { data: r } = await supabase.from('reminders').select('id, qstash_message_id, title').eq('user_id', Number(targetId)).ilike('title', `%${p.query}%`).eq('status', 'pending').maybeSingle();
  if (!r) return 'Lembrete não encontrado.';
  if (r.qstash_message_id) await cancelReminderOnQStash(r.qstash_message_id);
  await supabase.from('reminders').update({ status: 'cancelled' }).eq('id', r.id);
  return `Lembrete "${r.title}" cancelado com sucesso.`;
}