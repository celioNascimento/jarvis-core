import { supabase } from '@/lib/jarvis';
import { scheduleReminderOnQStash, cancelReminderOnQStash } from '@/lib/qstash';
import { getEffectiveUserId } from '@/lib/modules/relationships';
import { invalidateMasterContextCache } from '@/lib/chat/pipeline/intelligence';

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

export async function executeCreateReminder(
  p: { title?: string; message?: string; type?: string; scheduled_time?: string; delay_minutes?: number; frequency?: string; },
  authUserId: string,
  numericUserId: string,
  sessionId: string // Adicionado para invalidação
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const agora = new Date();
    const title = p.title ?? p.message ?? 'Lembrete';
    let freq = p.frequency;
    let scheduled_time = p.scheduled_time;

    if (p.delay_minutes) {
      scheduled_time = new Date(agora.getTime() + p.delay_minutes * 60000).toISOString();
    } else if (scheduled_time && scheduled_time.length <= 8 && scheduled_time.includes(':')) {
      const [h, m] = scheduled_time.split(':').map(Number);
      const dataRef = new Date(agora);
      dataRef.setHours(h, m, 0, 0);
      if (dataRef.getTime() <= agora.getTime()) dataRef.setDate(dataRef.getDate() + 1);
      scheduled_time = dataRef.toISOString();
    } else if (!scheduled_time) {
      scheduled_time = new Date(agora.getTime() + 5 * 60000).toISOString();
    }

    if (freq?.toLowerCase().includes('útil')) freq = 'weekdays';

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
    
    // 🔥 AÇÃO CRÍTICA: Invalida o cache para o lembrete aparecer na próxima mensagem
    await invalidateMasterContextCache(Number(targetId), sessionId);

    const qstashId = await scheduleReminderOnQStash({
      reminderId: String(reminder.id),
      userId: String(targetId),
      authUserId,
      message: title,
      scheduledTime: scheduled_time,
      cron: freq ? getCronExpression(freq, new Date(scheduled_time)) : null
    });

    if (qstashId) {
      await supabase.from('reminders').update({ qstash_message_id: qstashId }).eq('id', reminder.id);
    }

    return `Sucesso: Lembrete "${title}" agendado para ${new Date(scheduled_time).toLocaleString('pt-BR')}.`;
  } catch (err: any) { 
    return `Erro ao processar lembrete: ${err.message}`; 
  }
}

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

export async function executeCancelarLembrete(
  p: { query: string },
  authUserId: string,
  numericUserId: string,
  sessionId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { data: r } = await supabase.from('reminders').select('id, qstash_message_id, title')
      .eq('user_id', Number(targetId)).ilike('title', `%${p.query}%`).eq('status', 'pending').maybeSingle();
    if (!r) return 'Lembrete não encontrado.';
    if (r.qstash_message_id) await cancelReminderOnQStash(r.qstash_message_id);
    await supabase.from('reminders').update({ status: 'cancelled' }).eq('id', r.id);
    
    await invalidateMasterContextCache(Number(targetId), sessionId);
    return `Lembrete "${r.title}" cancelado.`;
  } catch { return 'Erro ao cancelar.'; }
}