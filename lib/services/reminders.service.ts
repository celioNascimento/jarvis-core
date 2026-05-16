// lib/services/reminders.service.ts
// V1.4.0 — Autopopulate reminder_shares via Active Relationships

import { supabase } from '@/lib/jarvis';
import { scheduleReminderOnQStash, cancelReminderOnQStash, frequencyToCron } from '@/lib/qstash';

export interface ReminderPayload {
  title: string;
  type?: 'temporary' | 'recurring' | 'location';
  scheduled_time?: string | null;
  delay_minutes?: number;
  frequency?: string | null;
  location_trigger?: string | null;
  metadata?: Record<string, any>;
}

export interface ReminderUpdatePayload {
  title?: string;
  type?: string;
  scheduled_time?: string;
  frequency?: string;
  status?: string;
  metadata?: Record<string, any>;
}

// ─── 1. LISTAR (APP) ──────────────────────────────────────────────────────────
export async function coreListarLembretes(
  userId: number,
  incluirHistorico = false
): Promise<any[]> {
  let query = supabase
    .from('reminders')
    .select('*')
    .eq('user_id', userId);

  if (!incluirHistorico) {
    const agoraISO = new Date().toISOString();
    const ontemISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    query = query.or(
      `and(status.eq.pending,scheduled_time.gte.${agoraISO}),and(status.eq.triggered,fired_at.gte.${ontemISO})`
    );
  }

  const { data: own, error } = await query
    .order('scheduled_time', { ascending: true, nullsFirst: false });

  if (error) throw new Error(`Falha ao listar lembretes: ${error.message}`);

  const { data: shares } = await supabase
    .from('reminder_shares')
    .select('reminder_id')
    .eq('shared_with_id', userId)
    .eq('active', true);

  const sharedIds = (shares ?? []).map(s => s.reminder_id);
  let shared: any[] = [];

  if (sharedIds.length > 0) {
    const { data, error: sharedError } = await supabase
      .from('reminders')
      .select('*')
      .in('id', sharedIds)
      .eq('status', 'pending')
      .gte('scheduled_time', new Date().toISOString())
      .order('scheduled_time', { ascending: true, nullsFirst: false });

    if (sharedError) throw new Error(`Falha ao listar compartilhados: ${sharedError.message}`);
    shared = (data ?? []).map(r => ({ ...r, shared_from_partner: true }));
  }

  return [...(own ?? []), ...shared].sort((a, b) => {
    if (!a.scheduled_time) return 1;
    if (!b.scheduled_time) return -1;
    return new Date(a.scheduled_time).getTime() - new Date(b.scheduled_time).getTime();
  });
}

// ─── 2. CONSULTAR (CHAT) ──────────────────────────────────────────────────────
export async function coreConsultarLembretes(userId: number): Promise<string> {
  const { data, error } = await supabase
    .from('reminders')
    .select('title, scheduled_time, frequency, type')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .gte('scheduled_time', new Date().toISOString())
    .order('scheduled_time', { ascending: true })
    .limit(20);

  if (error) throw new Error(`Falha ao consultar lembretes: ${error.message}`);
  if (!data || data.length === 0) return 'Nenhum lembrete pendente.';

  return data.map(r => {
    const hora = new Date(r.scheduled_time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const freq = r.frequency ? ` (${r.frequency})` : '';
    return `- ${r.title} → ${hora}${freq}`;
  }).join('\n');
}

// ─── 3. CRIAR WITH AUTO-SHARE (CHAT & APP) ────────────────────────────────────
export async function coreCriarLembrete(
  userId: number,
  authUserId: string,
  payload: ReminderPayload
): Promise<{ id: string; title: string; scheduled_time: string }> {
  const agora = new Date();
  let scheduled_time: string;
  let freq = payload.frequency;

  if (payload.delay_minutes) {
    scheduled_time = new Date(agora.getTime() + payload.delay_minutes * 60000).toISOString();
  } else if (payload.scheduled_time && payload.scheduled_time.length <= 8 && payload.scheduled_time.includes(':')) {
    const [h, m] = payload.scheduled_time.split(':').map(Number);
    const dataBR = new Intl.DateTimeFormat('fr-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
    const target = new Date(`${dataBR}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-03:00`);
    if (target.getTime() <= agora.getTime()) target.setDate(target.getDate() + 1);
    scheduled_time = target.toISOString();
  } else if (payload.scheduled_time?.endsWith('Z')) {
    scheduled_time = new Date(payload.scheduled_time.replace('Z', '-03:00')).toISOString();
  } else if (payload.scheduled_time) {
    const parsed = new Date(payload.scheduled_time);
    if (isNaN(parsed.getTime())) throw new Error(`Data inválida: ${payload.scheduled_time}`);
    scheduled_time = parsed.toISOString();
  } else {
    scheduled_time = new Date(agora.getTime() + 5 * 60000).toISOString();
  }

  if (freq?.toLowerCase().includes('útil')) freq = 'weekdays';

  // 1. Salva o Lembrete base
  const { data: reminder, error } = await supabase
    .from('reminders')
    .insert({
      user_id:          userId,
      title:            payload.title,
      type:             payload.type ?? (freq ? 'recurring' : 'temporary'),
      frequency:        freq ?? null,
      scheduled_time,
      location_trigger: payload.location_trigger ?? null,
      metadata:         payload.metadata ?? null,
      status:           'pending',
      source:           'lev',
    })
    .select('id')
    .single();

  if (error) throw new Error(`Falha no banco: ${error.message}`);

  // 👥 2. CRUZAMENTO DE VÍNCULOS MULTIPLAYER AUTOMÁTICO
  try {
    const { data: relationships } = await supabase
      .from('relationships')
      .select('user_id_a, user_id_b, settings')
      .eq('status', 'active')
      .or(`user_id_a.eq.${authUserId},user_id_b.eq.${authUserId}`);

    if (relationships && relationships.length > 0) {
      for (const rel of relationships) {
        const settings = rel.settings || {};
        // Verifica se a chave de sincronização de lembretes está ativa no vínculo
        if (settings.reminders === true || settings.reminder === true) {
          const partnerAuthId = rel.user_id_a === authUserId ? rel.user_id_b : rel.user_id_a;

          // Busca o ID numérico do parceiro para inserir em reminder_shares
          const { data: partnerUser } = await supabase
            .from('users')
            .select('id')
            .eq('auth_user_id', partnerAuthId)
            .maybeSingle();

          if (partnerUser) {
            await supabase
              .from('reminder_shares')
              .insert({
                reminder_id: reminder.id,
                shared_with_id: partnerUser.id,
                active: true
              });
            console.log(`[Multiplayer] Lembrete ${reminder.id} compartilhado automaticamente com ID: ${partnerUser.id}`);
          }
        }
      }
    }
  } catch (shareErr: any) {
    // Abafa erros de compartilhamento para não travar a criação principal do lembrete
    console.error('[Multiplayer Share Error] Falha silenciosa:', shareErr.message);
  }

  // 3. Agendamento no QStash
  const cron = freq ? frequencyToCron(freq, scheduled_time) : null;
  let qstashId: string | null = null;
  
  try {
    qstashId = await scheduleReminderOnQStash({
      reminderId:    String(reminder.id),
      userId:        String(userId),
      authUserId,
      message:       payload.title,
      scheduledTime: scheduled_time,
      cron,
    });
  } catch (qstashError: any) {
    console.error(`[QStash FALHA] Lembrete ${reminder.id} sem agendamento:`, qstashError.message);
  }

  if (qstashId) {
    await supabase
      .from('reminders')
      .update({ qstash_message_id: qstashId })
      .eq('id', reminder.id);
  }

  return { id: reminder.id, title: payload.title, scheduled_time };
}

// ─── 4. ATUALIZAR (APP) ───────────────────────────────────────────────────────
export async function coreAtualizarLembrete(
  userId: number,
  authUserId: string,
  id: string,
  payload: ReminderUpdatePayload
): Promise<any> {
  const { data: old, error: fetchError } = await supabase
    .from('reminders')
    .select('user_id, qstash_message_id')
    .eq('id', id)
    .single();

  if (fetchError || !old) throw new Error('Lembrete não encontrado.');
  if (old.user_id !== userId) throw new Error('FORBIDDEN: Sem permissão para editar.');

  if (old.qstash_message_id) await cancelReminderOnQStash(old.qstash_message_id);

  const { data: updated, error: updateError } = await supabase
    .from('reminders')
    .update({ ...payload, qstash_message_id: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (updateError) throw new Error(`Falha ao atualizar: ${updateError.message}`);

  if (updated.status === 'pending' && updated.scheduled_time && updated.type !== 'location') {
    const cron = updated.frequency ? frequencyToCron(updated.frequency, updated.scheduled_time) : null;

    const qstashId = await scheduleReminderOnQStash({
      reminderId:    updated.id,
      userId:        String(userId),
      authUserId,
      message:       updated.title,
      scheduledTime: updated.scheduled_time,
      cron,
    });

    if (qstashId) {
      await supabase
        .from('reminders')
        .update({ qstash_message_id: qstashId })
        .eq('id', updated.id);
    }
  }

  return updated;
}

// ─── 5. CANCELAR POR BUSCA (CHAT) ─────────────────────────────────────────────
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
  
  await supabase
    .from('reminders')
    .update({ status: 'cancelled' })
    .eq('id', reminder.id);

  return reminder.title;
}

// ─── 6. DELETAR POR ID (APP) ──────────────────────────────────────────────────
export async function coreDeletarLembrete(userId: number, id: string): Promise<void> {
  const { data: reminder, error } = await supabase
    .from('reminders')
    .select('user_id, qstash_message_id')
    .eq('id', id)
    .single();

  if (error || !reminder) throw new Error('Lembrete não encontrado.');
  if (reminder.user_id !== userId) throw new Error('FORBIDDEN: Sem permissão para deletar.');

  if (reminder.qstash_message_id) await cancelReminderOnQStash(reminder.qstash_message_id);
  await supabase.from('reminders').delete().eq('id', id);
}
