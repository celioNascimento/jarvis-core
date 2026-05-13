// lib/tools/executors/agenda.ts
// V12.2.0 — Blindagem Total (Resolução Centralizada & Retorno Garantido)

import { supabase } from '@/lib/jarvis';
import { getGoogleContext, createGoogleEvent, trashGoogleEmail } from '@/lib/google';
import { getRecentEmails, getMicrosoftCalendarContext } from '@/lib/microsoft';
import { scheduleReminderOnQStash, cancelReminderOnQStash } from '@/lib/qstash';
import { 
  getEffectiveUserId, 
  resolveUser, 
  formatDisplayName 
} from '@/lib/modules/relationships';

// ─── HELPERS DE DATA ─────────────────────────────────────────────────────────

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

// ─── EXECUTORES ───────────────────────────────────────────────────────────────

/**
 * Consulta a agenda unificada (Lev + Google + Outlook).
 */
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
        p_days: p.dias ?? 7,
      }),
      getGoogleContext().catch(() => null),
      getMicrosoftCalendarContext().catch(() => null),
    ]);

    const lev = (levRes.status === 'fulfilled' && levRes.value.data)
      ? levRes.value.data
      : 'Nenhum evento na Agenda Lev.';

    let result = `[AGENDA LEV]\n${lev}`;
    if (googleRes.status === 'fulfilled' && googleRes.value) result += `\n\n[GOOGLE]\n${googleRes.value}`;
    if (outlookRes.status === 'fulfilled' && outlookRes.value) result += `\n\n[OUTLOOK]\n${outlookRes.value}`;

    return result;
  } catch (err: any) {
    return `Erro ao consultar agenda: ${err.message}`;
  }
}

/**
 * Salva um compromisso na Agenda Lev com radar de conflitos.
 */
export async function executeSalvarEvento(
  p: { title?: string; summary?: string; event_date?: string; startTime?: string; category?: string; notes?: string; reminderMinutes?: number; force?: boolean; },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    
    // Tratamento de data nula ou indefinida
    const rawInput = p.event_date ?? p.startTime ?? new Date().toISOString();
    let rawDate = rawInput.trim().replace(' ', 'T');

    const anoAtual = new Date().getFullYear();
    const anoEvento = parseInt(rawDate.substring(0, 4));

    if (anoEvento > 0 && (anoEvento < anoAtual || isNaN(anoEvento))) {
      rawDate = String(anoAtual) + rawDate.substring(4);
    }

    const withOffset = /(Z|[+-]\d{2}:\d{2})$/.test(rawDate) ? rawDate : `${rawDate}-03:00`;
    const startDate = new Date(withOffset);
    if (isNaN(startDate.getTime())) return 'Erro: A data informada é inválida.';

    const startISO = startDate.toISOString();
    const endISO = new Date(startDate.getTime() + 3600000).toISOString();

    if (!p.force) {
      const { data: conflitos } = await supabase.from('events').select('title, start_at')
        .eq('user_id', Number(targetId)).lt('start_at', endISO).gt('end_at', startISO);

      if (conflitos?.length) {
        const hora = new Date(conflitos[0].start_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return `[CONFLITO] Você já tem "${conflitos[0].title}" às ${hora}. Deseja forçar o agendamento?`;
      }
    }

    const { error } = await supabase.from('events').insert({
      user_id: Number(targetId),
      title: p.title ?? p.summary ?? 'Compromisso sem título',
      start_at: startISO,
      end_at: endISO,
      category: p.category ?? 'personal',
      source: 'lev',
      reminder_minutes: [p.reminderMinutes ?? 30],
      notes: p.notes ?? null,
    });

    if (error) throw error;
    return `Evento "${p.title ?? p.summary}" salvo com sucesso para ${startDate.toLocaleString('pt-BR')}.`;
  } catch (err: any) {
    return `Erro ao salvar evento: ${err.message}`;
  }
}

/**
 * Cria um lembrete (tempo/recorrência) com QStash.
 */
export async function executeCreateReminder(
  p: { title?: string; message?: string; type?: string; scheduled_time?: string; delay_minutes?: number; frequency?: string; },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const agora = new Date();
    const title = p.title ?? p.message ?? 'Lembrete';
    let freq = p.frequency;
    
    // Fallback elegante para garantir string
    let scheduled_time = p.scheduled_time ?? agora.toISOString();

    if (freq?.toLowerCase().includes('útil')) freq = 'weekdays';

    // Normalização de hora simples
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
      const finalStr = scheduled_time.includes('Z') || /[+-]\d{2}:\d{2}$/.test(scheduled_time)
        ? scheduled_time
        : `${scheduled_time}-03:00`;
      scheduled_time = new Date(finalStr).toISOString();
    }

    const { data: reminder, error } = await supabase.from('reminders').insert({
      user_id: Number(targetId),
      title,
      type: p.type ?? (freq ? 'recurring' : 'temporary'),
      frequency: freq ?? null,
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

    if (qstashId) {
      await supabase.from('reminders').update({ qstash_message_id: qstashId }).eq('id', reminder.id);
    }

    return `Lembrete "${title}" agendado para ${new Date(scheduled_time).toLocaleString('pt-BR')}.`;
  } catch (err: any) {
    return `Erro ao criar lembrete: ${err.message}`;
  }
}

// ── EXPORTS OBRIGATÓRIOS (BUILD RESILIENCE) ──────────────────────────────────

export async function executeCriarEventoAgenda(p: any): Promise<string> {
  try {
    return await createGoogleEvent(p.summary, p.startTime, p.reminderMinutes ?? 30);
  } catch (err: any) {
    return `Erro no Google Calendar: ${err.message}`;
  }
}

export async function executeListarEmailsRecentes(p: any): Promise<string> {
  try {
    return await getRecentEmails(p.filtro, 5, true);
  } catch (err: any) {
    return `Erro no Gmail: ${err.message}`;
  }
}

export async function executeExcluirEmail(p: any): Promise<string> {
  try {
    return await trashGoogleEmail(p.messageId);
  } catch (err: any) {
    return `Erro ao excluir: ${err.message}`;
  }
}

export async function executeConsultarLembretes(_p: any, aId: string, nId: string): Promise<string> {
  try {
    const tId = await getEffectiveUserId(aId, nId);
    const { data } = await supabase.from('reminders').select('title, scheduled_time')
      .eq('user_id', Number(tId)).eq('status', 'pending').gte('scheduled_time', new Date().toISOString());
    
    if (!data?.length) return 'Nenhum lembrete pendente.';
    return data.map(r => `- ${r.title} (${new Date(r.scheduled_time).toLocaleString('pt-BR')})`).join('\n');
  } catch {
    return 'Erro ao buscar lembretes.';
  }
}

export async function executeDeletarEvento(p: { query: string }, aId: string, nId: string): Promise<string> {
  try {
    const tId = await getEffectiveUserId(aId, nId);
    const { error } = await supabase.from('events').delete().eq('user_id', Number(tId)).ilike('title', `%${p.query}%`);
    return error ? 'Erro ao excluir.' : `Eventos sobre "${p.query}" foram removidos.`;
  } catch {
    return 'Falha na exclusão do evento.';
  }
}

export async function executeCancelarLembrete(p: { query: string }, aId: string, nId: string): Promise<string> {
  try {
    const tId = await getEffectiveUserId(aId, nId);
    const { data: r } = await supabase.from('reminders').select('id, qstash_message_id, title')
      .eq('user_id', Number(tId)).ilike('title', `%${p.query}%`).eq('status', 'pending').maybeSingle();

    if (!r) return 'Lembrete não encontrado.';
    if (r.qstash_message_id) await cancelReminderOnQStash(r.qstash_message_id);
    await supabase.from('reminders').update({ status: 'cancelled' }).eq('id', r.id);
    return `Lembrete "${r.title}" cancelado.`;
  } catch {
    return 'Erro ao cancelar lembrete.';
  }
}