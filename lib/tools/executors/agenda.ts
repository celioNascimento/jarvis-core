// lib/tools/executors/agenda.ts
// V12.3.0 — Assinaturas unificadas para compatibilidade com o Dispatcher

import { supabase } from '@/lib/jarvis';
import { getGoogleContext, createGoogleEvent, trashGoogleEmail } from '@/lib/google';
import { getRecentEmails, getMicrosoftCalendarContext } from '@/lib/microsoft';
import { scheduleReminderOnQStash, cancelReminderOnQStash } from '@/lib/qstash';
import { 
  getEffectiveUserId, 
  resolveUser, 
  formatDisplayName 
} from '@/lib/modules/relationships';

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
        p_days: p.dias ?? 7,
      }),
      getGoogleContext().catch(() => null),
      getMicrosoftCalendarContext().catch(() => null),
    ]);

    const lev = (levRes.status === 'fulfilled' && levRes.value.data) ? levRes.value.data : 'Nenhum evento na Agenda Lev.';
    let result = `[AGENDA LEV]\n${lev}`;
    if (googleRes.status === 'fulfilled' && googleRes.value) result += `\n\n[GOOGLE]\n${googleRes.value}`;
    if (outlookRes.status === 'fulfilled' && outlookRes.value) result += `\n\n[OUTLOOK]\n${outlookRes.value}`;
    return result;
  } catch (err: any) { return `Erro: ${err.message}`; }
}

// ─── 2. SALVAR EVENTO (LEV) ───────────────────────────────────────────────────

export async function executeSalvarEvento(
  p: { title?: string; summary?: string; event_date?: string; startTime?: string; category?: string; notes?: string; reminderMinutes?: number; force?: boolean; },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const rawInput = p.event_date ?? p.startTime ?? new Date().toISOString();
    let rawDate = rawInput.trim().replace(' ', 'T');
    const withOffset = /(Z|[+-]\d{2}:\d{2})$/.test(rawDate) ? rawDate : `${rawDate}-03:00`;
    const startDate = new Date(withOffset);
    if (isNaN(startDate.getTime())) return 'Erro: data inválida.';

    const startISO = startDate.toISOString();
    const endISO = new Date(startDate.getTime() + 3600000).toISOString();

    if (!p.force) {
      const { data: conflitos } = await supabase.from('events').select('title, start_at')
        .eq('user_id', Number(targetId)).lt('start_at', endISO).gt('end_at', startISO);
      if (conflitos?.length) return `[CONFLITO] Você já tem "${conflitos[0].title}".`;
    }

    const { error } = await supabase.from('events').insert({
      user_id: Number(targetId),
      title: p.title ?? p.summary ?? 'Sem título',
      start_at: startISO,
      end_at: endISO,
      category: p.category ?? 'personal',
      source: 'lev',
      reminder_minutes: [p.reminderMinutes ?? 30],
    });
    if (error) throw error;
    return `Evento salvo para ${startDate.toLocaleString('pt-BR')}.`;
  } catch (err: any) { return `Erro: ${err.message}`; }
}

// ─── 3. CRIAR EVENTO GOOGLE (EXTERNO) ─────────────────────────────────────────

export async function executeCriarEventoAgenda(
  p: { summary: string; startTime: string; reminderMinutes?: number },
  _authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    return await createGoogleEvent(p.summary, p.startTime, p.reminderMinutes ?? 30);
  } catch (err: any) { return `Erro no Google: ${err.message}`; }
}

// ─── 4. LISTAR EMAILS ─────────────────────────────────────────────────────────

export async function executeListarEmailsRecentes(
  p: { filtro?: string },
  _authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    return await getRecentEmails(p.filtro, 5, true);
  } catch (err: any) { return `Erro no Gmail: ${err.message}`; }
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
    const agora = new Date();
    const title = p.title ?? p.message ?? 'Lembrete';
    let freq = p.frequency;
    
    // ── LÓGICA DE TEMPO ROBUSTA ──
    let scheduled_time = p.scheduled_time;

    // 1. Se houver delay_minutes (ex: "em 1 minuto"), calcula a partir de agora
    if (p.delay_minutes) {
      scheduled_time = new Date(agora.getTime() + p.delay_minutes * 60000).toISOString();
    } 
    // 2. Se for apenas hora (ex: "08:00"), normaliza para hoje/amanhã
    else if (scheduled_time && scheduled_time.length <= 8 && scheduled_time.includes(':')) {
      const [h, m] = scheduled_time.split(':').map(Number);
      const dataRef = new Date(agora);
      dataRef.setHours(h, m, 0, 0);
      if (dataRef.getTime() <= agora.getTime()) dataRef.setDate(dataRef.getDate() + 1);
      scheduled_time = dataRef.toISOString();
    }
    // 3. Fallback: se nada for enviado, coloca para daqui a 5 min
    else if (!scheduled_time) {
      scheduled_time = new Date(agora.getTime() + 5 * 60000).toISOString();
    }

    if (freq?.toLowerCase().includes('útil')) freq = 'weekdays';

    // Inserção direta via Service Role (Bypassa a API Route e evita 404)
    const { data: reminder, error } = await supabase
      .from('reminders')
      .insert({
        user_id: Number(targetId),
        title,
        type: p.type ?? (freq ? 'recurring' : 'temporary'),
        frequency: freq ?? null,
        scheduled_time,
        status: 'pending'
      })
      .select('id')
      .single();

    if (error) throw error;
    
    // Agenda no QStash
    const qstashId = await scheduleReminderOnQStash({
      reminderId: String(reminder.id),
      userId: String(targetId),
      authUserId,
      message: title,
      scheduledTime: scheduled_time,
      cron: freq ? getCronExpression(freq, new Date(scheduled_time)) : null
    });

    if (qstashId) {
      await supabase
        .from('reminders')
        .update({ qstash_message_id: qstashId })
        .eq('id', reminder.id);
    }

    return `Sucesso: Lembrete "${title}" agendado para ${new Date(scheduled_time).toLocaleString('pt-BR')}.`;
  } catch (err: any) { 
    console.error('[Tool: CreateReminder] Erro:', err.message);
    return `Erro ao processar lembrete: ${err.message}`; 
  }
}


// ─── 7. CONSULTAR LEMBRETES ───────────────────────────────────────────────────

export async function executeConsultarLembretes(
  _p: any,
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { data } = await supabase.from('reminders').select('title, scheduled_time')
      .eq('user_id', Number(targetId)).eq('status', 'pending').gte('scheduled_time', new Date().toISOString());
    return data?.map(r => `- ${r.title} (${new Date(r.scheduled_time).toLocaleString('pt-BR')})`).join('\n') || 'Sem lembretes.';
  } catch { return 'Erro ao buscar lembretes.'; }
}

// ─── 8. DELETAR EVENTO ────────────────────────────────────────────────────────

export async function executeDeletarEvento(
  p: { query: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    await supabase.from('events').delete().eq('user_id', Number(targetId)).ilike('title', `%${p.query}%`);
    return `Eventos sobre "${p.query}" removidos.`;
  } catch { return 'Erro ao deletar.'; }
}

// ─── 9. CANCELAR LEMBRETE ──────────────────────────────────────────────────────

export async function executeCancelarLembrete(
  p: { query: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { data: r } = await supabase.from('reminders').select('id, qstash_message_id, title')
      .eq('user_id', Number(targetId)).ilike('title', `%${p.query}%`).eq('status', 'pending').maybeSingle();
    if (!r) return 'Lembrete não encontrado.';
    if (r.qstash_message_id) await cancelReminderOnQStash(r.qstash_message_id);
    await supabase.from('reminders').update({ status: 'cancelled' }).eq('id', r.id);
    return `Lembrete "${r.title}" cancelado.`;
  } catch { return 'Erro ao cancelar.'; }
}
