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
  sessionId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const agora = new Date();
    const title = p.title ?? p.message ?? 'Lembrete';
    let freq = p.frequency;
    let scheduled_time = p.scheduled_time;

    // ── LÓGICA DE TEMPO BLINDADA (IMUNE AO UTC DA VERCEL) ──
    if (p.delay_minutes) {
      // Se for delay (ex: "em 10 min"), o Date() local do runtime resolve bem
      scheduled_time = new Date(agora.getTime() + p.delay_minutes * 60000).toISOString();
    }
    else if (scheduled_time && scheduled_time.length <= 8 && scheduled_time.includes(':')) {
      const [h, m] = scheduled_time.split(':').map(Number);

      // 1. Pega a data YYYY-MM-DD atual no fuso de São Paulo
      const dataBR = new Intl.DateTimeFormat('fr-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);

      // 2. Monta a string forçando o offset de Brasília (-03:00)
      // Isso evita que o servidor interprete "06:15" como UTC e subtraia 3 horas.
      const targetDate = new Date(`${dataBR}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-03:00`);

      // 3. Se o horário já passou hoje, agenda para amanhã no mesmo horário
      if (targetDate.getTime() <= agora.getTime()) {
        targetDate.setDate(targetDate.getDate() + 1);
      }
      scheduled_time = targetDate.toISOString();
    }
    else if (scheduled_time && scheduled_time.endsWith('Z')) {
      // Se a IA enviou com 'Z' (UTC) por vício, reajustamos para o nosso fuso
      const fixedTime = scheduled_time.replace('Z', '-03:00');
      scheduled_time = new Date(fixedTime).toISOString();
    }
    else if (!scheduled_time) {
      // Fallback: daqui a 5 minutos
      scheduled_time = new Date(agora.getTime() + 5 * 60000).toISOString();
    }

    if (freq?.toLowerCase().includes('útil')) freq = 'weekdays';

    // ── PERSISTÊNCIA NO SUPABASE ──
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

    // 🔥 INVALIDAÇÃO DE CACHE: Garante que o Jarvis "veja" o lembrete na resposta imediata
    await invalidateMasterContextCache(Number(targetId), sessionId);

    // ── AGENDAMENTO NO QSTASH ──
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

    const formattedTime = new Date(scheduled_time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return `Sucesso: Lembrete "${title}" agendado para ${formattedTime}.`;

  } catch (err: any) {
    console.error('[Tool: CreateReminder] Erro Crítico:', err.message);
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