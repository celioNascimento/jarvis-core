// lib/tools/executors/agenda.ts
// Domínio: Agenda
// Tools: consultar_agenda, salvar_evento, criar_evento_agenda,
//        listar_emails_recentes, excluir_email, create_reminder,
//        consultar_lembretes

import { supabase } from '@/lib/jarvis';
import { getRecentEmails, getMicrosoftCalendarContext } from '@/lib/microsoft';
import { getGoogleContext, createGoogleEvent, trashGoogleEmail } from '@/lib/google';
import { scheduleReminderOnQStash } from '@/lib/qstash';

// ─── consultar_agenda ─────────────────────────────────────────────────────────

export async function executeConsultarAgenda(
  p: { dias?: number },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const [levRes, googleRes, outlookRes] = await Promise.allSettled([
      supabase
        .schema('jarvis')
        .rpc('get_calendar_context_for_jarvis', {
          p_user_id: Number(numericUserId),
          p_days:    p.dias || 7,
        }),
      getGoogleContext().catch(() => null),
      getMicrosoftCalendarContext().catch(() => null),
    ]);

    const lev = levRes.status === 'fulfilled' && levRes.value.data
      ? levRes.value.data
      : 'Nenhum evento encontrado na Agenda Lev.';

    let result = `[AGENDA LEV - FONTE PRINCIPAL]\n${lev}`;
    if (googleRes.status === 'fulfilled' && googleRes.value)
      result += `\n\n[GOOGLE CALENDAR]\n${googleRes.value}`;
    if (outlookRes.status === 'fulfilled' && outlookRes.value)
      result += `\n\n[OUTLOOK]\n${outlookRes.value}`;

    return result;
  } catch {
    return 'Erro ao consultar agenda.';
  }
}

// ─── salvar_evento ────────────────────────────────────────────────────────────

export async function executeSalvarEvento(
  p: {
    title?: string;
    summary?: string;
    event_date?: string;
    startTime?: string;
    category?: string;
    notes?: string;
    reminderMinutes?: number;
    force?: boolean;
  },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const anoAtual = new Date().getFullYear();
    let rawDate = (p.event_date || p.startTime || '').trim().replace(' ', 'T');

    // Corrige ano defasado
    const anoEvento = parseInt(rawDate.substring(0, 4));
    if (anoEvento > 0 && (anoEvento < anoAtual || isNaN(anoEvento))) {
      rawDate = String(anoAtual) + rawDate.substring(4);
    }

    const withOffset = /(Z|[+-]\d{2}:\d{2})$/.test(rawDate)
      ? rawDate
      : rawDate + '-03:00';

    const startDate = new Date(withOffset);
    if (isNaN(startDate.getTime())) {
      return `Erro: data inválida — "${p.event_date}". Por favor, informe dia e hora.`;
    }

    const endDate  = new Date(startDate.getTime() + 3600000);
    const startISO = startDate.toISOString();
    const endISO   = endDate.toISOString();

    // Radar de conflitos
    if (!p.force) {
      const { data: conflitos } = await supabase
        .schema('jarvis')
        .from('events')
        .select('title, start_at')
        .eq('user_id', Number(numericUserId))
        .lt('start_at', endISO)
        .gt('end_at', startISO);

      if (conflitos?.length) {
        const hora = new Date(conflitos[0].start_at).toLocaleTimeString('pt-BR', {
          hour: '2-digit', minute: '2-digit',
        });
        return `[ALERTA DE CONFLITO] Às ${hora} você já tem "${conflitos[0].title}". Deseja agendar mesmo assim? (Diga "pode forçar" para ignorar).`;
      }
    }

    const { error } = await supabase
      .schema('jarvis')
      .from('events')
      .insert({
        user_id:          Number(numericUserId),
        title:            p.title || p.summary,
        start_at:         startISO,
        end_at:           endISO,
        all_day:          false,
        category:         p.category || 'personal',
        source:           'lev',
        reminder_minutes: [p.reminderMinutes ?? 30],
        notes:            p.notes || null,
      });

    if (error) throw error;

    return `Evento "${p.title || p.summary}" salvo para ${startDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}. Radar de conflitos: Limpo.`;
  } catch (err: any) {
    return `Erro ao salvar evento: ${err.message}`;
  }
}

// ─── criar_evento_agenda (Google Calendar) ────────────────────────────────────

export async function executeCriarEventoAgenda(
  p: { summary: string; startTime: string; reminderMinutes?: number },
  _authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    return await createGoogleEvent(p.summary, p.startTime, p.reminderMinutes || 30);
  } catch (err: any) {
    return `Erro no Google Calendar: ${err.message}`;
  }
}

// ─── listar_emails_recentes ───────────────────────────────────────────────────

export async function executeListarEmailsRecentes(
  p: { filtro?: string },
  _authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    return await getRecentEmails(p.filtro, 5, true);
  } catch (err: any) {
    return `Erro no Gmail: ${err.message}`;
  }
}

// ─── excluir_email ────────────────────────────────────────────────────────────

export async function executeExcluirEmail(
  p: { messageId: string },
  _authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    return await trashGoogleEmail(p.messageId);
  } catch (err: any) {
    return `Erro ao excluir email: ${err.message}`;
  }
}

// ─── create_reminder ──────────────────────────────────────────────────────────

export async function executeCreateReminder(
  p: {
    title?: string;
    message?: string;
    type?: string;
    scheduled_time?: string;
    delay_minutes?: number;
    frequency?: string;
    location_trigger?: string;
  },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const title = p.title || p.message || 'Lembrete (sem título)';

    let scheduled_time = p.scheduled_time;
    if (scheduled_time) {
      if (!/(Z|[+-]\d{2}:\d{2})$/.test(scheduled_time)) {
        scheduled_time += '-03:00';
      }
      scheduled_time = new Date(scheduled_time).toISOString();
    } else {
      scheduled_time = p.delay_minutes
        ? new Date(Date.now() + p.delay_minutes * 60000).toISOString()
        : new Date(Date.now() + 300000).toISOString();
    }

    const { data: reminder, error } = await supabase
      .schema('jarvis')
      .from('reminders')
      .insert({
        user_id:        Number(numericUserId),
        title,
        type:           p.type || 'temporary',
        scheduled_time,
        status:         'pending',
        metadata:       { auth_user_id: authUserId },
      })
      .select('id')
      .single();

    if (error) throw error;

    const qstashId = await scheduleReminderOnQStash({
      reminderId:    String(reminder.id),
      userId:        numericUserId,
      authUserId,
      message:       title,
      scheduledTime: scheduled_time,
    });

    if (qstashId) {
      await supabase
        .schema('jarvis')
        .from('reminders')
        .update({ qstash_message_id: qstashId })
        .eq('id', reminder.id);
    }

    const dtFormatted = new Date(scheduled_time).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour:     '2-digit',
      minute:   '2-digit',
    });
    return `Lembrete agendado: "${title}" às ${dtFormatted}.`;
  } catch (err: any) {
    return `Erro ao criar lembrete: ${err.message}`;
  }
}

// ─── consultar_lembretes ──────────────────────────────────────────────────────

export async function executeConsultarLembretes(
  _p: Record<string, never>,
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const { data: reminders } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select('title, scheduled_time, status')
      .eq('user_id', Number(numericUserId))
      .eq('status', 'pending')
      .gte('scheduled_time', new Date().toISOString())
      .order('scheduled_time', { ascending: true });

    if (!reminders?.length) return 'Você não tem lembretes pendentes para o futuro.';

    return reminders
      .map(r => {
        const dt = new Date(r.scheduled_time).toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
        });
        return `- ${r.title} (${dt})`;
      })
      .join('\n');
  } catch {
    return 'Erro ao ler tabela de lembretes.';
  }
}