// lib/services/agenda.service.ts
// V1.1.1 — Fonte Única da Verdade Completa (CRUD + IA)

import { supabase } from '@/lib/jarvis';
import { createGoogleEvent, getGoogleContext } from '@/lib/google';
import { getMicrosoftCalendarContext } from '@/lib/microsoft';
import { invalidateContextField } from '@/lib/services/context-cache';
import { scheduleReminderOnQStash, cancelReminderOnQStash } from '@/lib/qstash';

export interface EventPayload {
  titulo: string;
  data_hora_inicio: string;
  data_hora_fim?: string;
  categoria?: string;
  notas?: string;
  minutos_lembrete?: number[];
  sincronizar_google?: boolean;
  forcar_conflito?: boolean;
  source?: 'lev' | 'app';
  sessionId?: string;
}

// ─── 0. CONTROLE DE ACESSO (ACL) ──────────────────────────────────────────────
export async function verificarPermissaoEvento(eventId: string, userId: number): Promise<{ allowed: boolean; canWrite: boolean; event: any }> {
  const { data: event } = await supabase.schema('jarvis').from('events').select('*').eq('id', eventId).single();
  if (!event) return { allowed: false, canWrite: false, event: null };

  const isOwner = String(event.user_id) === String(userId);
  if (isOwner) return { allowed: true, canWrite: true, event };

  const { data: catShare } = await supabase.schema('jarvis').from('calendar_shares')
    .select('id').eq('owner_id', event.user_id).eq('shared_with_id', userId).eq('category', event.category).maybeSingle();
  if (catShare) return { allowed: true, canWrite: true, event };

  const { data: eventShare } = await supabase.schema('jarvis').from('calendar_event_shares')
    .select('id').eq('event_id', eventId).eq('shared_with_id', userId).maybeSingle();
  if (eventShare) return { allowed: true, canWrite: true, event };

  return { allowed: false, canWrite: false, event };
}

// ─── 1. CONSULTAR (USADO PELA IA) ─────────────────────────────────────────────
export async function coreConsultarAgenda(userId: number, dias: number = 7) {
  const [levRes, googleRes, outlookRes] = await Promise.allSettled([
    supabase.rpc('get_calendar_context_for_jarvis', { p_user_id: userId, p_days: dias }),
    getGoogleContext().catch(() => null),
    getMicrosoftCalendarContext().catch(() => null),
  ]);

  console.log('[coreConsultarAgenda] lev:', levRes.status, (levRes as any).value?.data?.substring(0, 100));
  console.log('[coreConsultarAgenda] google:', googleRes.status);
  console.log('[coreConsultarAgenda] outlook:', outlookRes.status)
  
  const lev = (levRes.status === 'fulfilled' && levRes.value?.data) ? levRes.value.data : 'Nenhum evento na Agenda Lev.';
  let result = `[AGENDA LEV]\n${lev}`;
  if (googleRes.status === 'fulfilled' && googleRes.value) result += `\n\n[GOOGLE]\n${googleRes.value}`;
  if (outlookRes.status === 'fulfilled' && outlookRes.value) result += `\n\n[OUTLOOK]\n${outlookRes.value}`;
  
  return result;
}

// ─── 2. CONSULTAR (USADO PELO APP WEB) ────────────────────────────────────────
export async function coreBuscarEventosApp(userId: number, from: string, to: string | null) {
  const userIdStr = String(userId);

  const { data: eventShares } = await supabase.schema('jarvis').from('calendar_event_shares').select('event_id').eq('shared_with_id', userId);
  const sharedEventIds = (eventShares ?? []).map(s => s.event_id);

  const { data: categoryShares } = await supabase.schema('jarvis').from('calendar_shares').select('owner_id, category').eq('shared_with_id', userId);

  let query = supabase.schema('jarvis').from('events').select('*').gte('start_at', from);
  if (to) query = query.lte('start_at', to);
  
  query = sharedEventIds.length > 0 
    ? query.or(`user_id.eq.${userId},id.in.(${sharedEventIds.join(',')})`) 
    : query.eq('user_id', userId);

  const { data: baseEvents } = await query.order('start_at', { ascending: true });

  let categoryEvents: any[] = [];
  for (const share of categoryShares ?? []) {
    let catQuery = supabase.schema('jarvis').from('events').select('*')
      .eq('user_id', share.owner_id).eq('category', share.category).gte('start_at', from).order('start_at', { ascending: true });
    if (to) catQuery = catQuery.lte('start_at', to);
    const { data: items } = await catQuery;
    if (items) categoryEvents = [...categoryEvents, ...items];
  }

  const marked = [
    ...(baseEvents ?? []).map(e => ({ ...e, shared_from_partner: String(e.user_id) !== userIdStr })),
    ...categoryEvents.map(e => ({ ...e, shared_from_partner: true })),
  ];

  const seen = new Set<string>();
  return marked.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  }).sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
}

// ─── 3. CRIAR (IA & APP WEB) ──────────────────────────────────────────────────
export async function coreCriarEvento(userId: number, payload: EventPayload) {
  let safeDateStr = payload.data_hora_inicio.trim().replace(' ', 'T');
  if (safeDateStr.endsWith('Z')) safeDateStr = safeDateStr.replace('Z', '-03:00');
  else if (!/(Z|[+-]\d{2}:\d{2})$/.test(safeDateStr)) safeDateStr += '-03:00';

  const startDate = new Date(safeDateStr);
  if (isNaN(startDate.getTime())) throw new Error('Data de início inválida.');

  const startISO = startDate.toISOString();
  const endISO = payload.data_hora_fim || new Date(startDate.getTime() + 3600000).toISOString();

  if (!payload.forcar_conflito) {
    const { data: conflitos } = await supabase.schema('jarvis').from('events')
      .select('title, start_at').eq('user_id', userId).lt('start_at', endISO).gt('end_at', startISO);
    if (conflitos && conflitos.length > 0) throw new Error(`CONFLITO_AGENDA: Você já tem "${conflitos[0].title}" neste horário.`);
  }

  let avisoGoogle = '';
  if (payload.sincronizar_google) {
    try {
      const reminderMin = payload.minutos_lembrete?.[0] ?? 30;
      await createGoogleEvent(payload.titulo, startISO, reminderMin);
      avisoGoogle = ' (Sincronizado c/ Google)';
    } catch (err: any) {
      avisoGoogle = ` (Falha Google: ${err.message})`;
    }
  }

  const { data: evento, error } = await supabase.schema('jarvis').from('events')
    .insert({
      user_id: userId, title: payload.titulo, start_at: startISO, end_at: endISO,
      category: payload.categoria ?? 'personal', description: payload.notas ?? '',
      source: payload.source ?? 'lev', reminder_minutes: payload.minutos_lembrete ?? [30],
    }).select().single();

  if (error) throw new Error(`Falha no banco: ${error.message}`);
  if (payload.sessionId) await invalidateContextField(userId, 'events').catch(() => {});


  return { evento, avisoGoogle, startDate };
}

// ─── 4. ATUALIZAR (APP WEB) ───────────────────────────────────────────────────
export async function coreAtualizarEvento(userId: number, eventId: string, authUserId: string, payload: any) {
  const { canWrite } = await verificarPermissaoEvento(eventId, userId);
  if (!canWrite) throw new Error('FORBIDDEN: Sem permissão para editar.');

  const { data: reminders } = await supabase.schema('jarvis').from('event_reminders').select('id, qstash_message_id').eq('event_id', eventId).eq('status', 'pending');
  for (const r of reminders ?? []) {
    if (r.qstash_message_id) await cancelReminderOnQStash(r.qstash_message_id);
  }
  await supabase.schema('jarvis').from('event_reminders').update({ status: 'cancelled' }).eq('event_id', eventId).eq('status', 'pending');

  const { data: event, error } = await supabase.schema('jarvis').from('events')
    .update({ ...payload, updated_at: new Date().toISOString() }).eq('id', eventId).select().single();

  if (error) throw new Error(`Falha ao atualizar: ${error.message}`);

  if (payload.reminder_minutes?.length) {
    for (const reminder of payload.reminder_minutes) {
      const scheduledAt = new Date(new Date(event.start_at).getTime() - reminder * 60000);
      if (scheduledAt > new Date()) {
        const messageId = await scheduleReminderOnQStash({
          reminderId: event.id, userId: String(userId), authUserId, message: `Lembrete: ${event.title}`, scheduledTime: scheduledAt.toISOString(),
        });
        if (messageId) {
          await supabase.schema('jarvis').from('event_reminders').insert({
            event_id: event.id, minutes_before: reminder, status: 'pending', qstash_message_id: messageId
          });
        }
      }
    }
  }
  return event;
}

// ─── 5. DELETAR (USADO PELA IA - POR BUSCA) ───────────────────────────────────
export async function coreDeletarEventoPorBusca(userId: number, busca: string, sessionId?: string) {
  const { data, error } = await supabase.schema('jarvis').from('events')
    .delete().eq('user_id', userId).ilike('title', `%${busca}%`).select('title');

  if (error) throw new Error(`Falha ao deletar: ${error.message}`);
  if (sessionId) await invalidateContextField(userId, 'events').catch(() => {});
  
  return data || [];


}

// ─── 6. DELETAR (USADO PELO APP WEB - POR ID) ─────────────────────────────────
export async function coreDeletarEventoPorId(userId: number, eventId: string) {
  const { canWrite } = await verificarPermissaoEvento(eventId, userId);
  if (!canWrite) throw new Error('FORBIDDEN: Sem permissão para apagar.');

  const { data: reminders } = await supabase.schema('jarvis').from('event_reminders').select('qstash_message_id').eq('event_id', eventId).eq('status', 'pending');
  for (const r of reminders ?? []) {
    if (r.qstash_message_id) await cancelReminderOnQStash(r.qstash_message_id);
  }

  const { error } = await supabase.schema('jarvis').from('events').delete().eq('id', eventId);
  if (error) throw new Error(`Falha ao deletar: ${error.message}`);
  return true;
}
