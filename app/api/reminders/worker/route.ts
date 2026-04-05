// app/api/reminders/worker/route.ts
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { sendPushNotification } from '@/lib/notifications/push';
import { isNationalHoliday, isMunicipalHoliday } from '@/lib/holidays';

// ============================================================
// Helper: Buscar timezone do usuário (da tabela users)
// ============================================================
async function getUserTimezone(userId: number): Promise<string> {
  const { data, error } = await supabase
    .from('users')
    .select('timezone')
    .eq('id', userId)
    .single();
  if (error || !data?.timezone) {
    console.warn(`[Worker] Usuário ${userId} sem timezone, usando America/Sao_Paulo`);
    return 'America/Sao_Paulo';
  }
  return data.timezone;
}

// ============================================================
// Helper: Buscar preferências de push do usuário
// ============================================================
async function getUserPushPreferences(userId: number) {
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('enabled, quiet_start, quiet_end, max_per_day, min_relevance_score')
    .eq('user_id', userId)
    .eq('channel', 'push')
    .maybeSingle();

  if (error) {
    console.error('[Prefs] Erro ao buscar preferências:', error);
  }
  // Valores padrão (caso não exista registro)
  return data || {
    enabled: true,
    quiet_start: '22:00',
    quiet_end: '07:00',
    max_per_day: 3,
    min_relevance_score: 0.65,
  };
}

// ============================================================
// Helper: Contar quantas notificações push já foram enviadas hoje
// ============================================================
async function getTodayPushCount(userId: number): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from('notifications_log')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('channel', 'push')
    .eq('type', 'event_reminder')
    .gte('sent_at', today.toISOString());

  if (error) {
    console.error('[Worker] Erro ao contar notificações de hoje:', error);
    return 0;
  }
  return count || 0;
}

// ============================================================
// Helper: Verifica se agora está dentro do horário de silêncio
// (respeita o timezone do usuário)
// ============================================================
function isQuietTime(
  nowUTC: Date,
  quietStart: string,
  quietEnd: string,
  userTimezone: string
): boolean {
  // Converte a hora atual para o fuso do usuário
  const userNow = new Date(nowUTC.toLocaleString('en-US', { timeZone: userTimezone }));
  const currentHour = userNow.getHours();
  const currentMinute = userNow.getMinutes();
  const currentMinutes = currentHour * 60 + currentMinute;

  const [startHour, startMinute] = quietStart.split(':').map(Number);
  const [endHour, endMinute] = quietEnd.split(':').map(Number);
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;

  // Se o silêncio ultrapassa meia-noite (ex: 22h -> 7h)
  if (endMinutes < startMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

// ============================================================
// Helper: Calcula o próximo horário fora do silêncio
// (ex: se está dentro do silêncio, reagenda para o fim do silêncio)
// ============================================================
function calculateNextQuietEnd(
  nowUTC: Date,
  quietEnd: string,
  userTimezone: string
): Date {
  const [endHour, endMinute] = quietEnd.split(':').map(Number);
  const userNow = new Date(nowUTC.toLocaleString('en-US', { timeZone: userTimezone }));
  let next = new Date(userNow);
  next.setHours(endHour, endMinute, 0, 0);
  // Se o fim do silêncio já passou hoje, avança para amanhã
  if (next <= userNow) {
    next.setDate(next.getDate() + 1);
  }
  // Converte de volta para UTC
  return new Date(next.toLocaleString('en-US', { timeZone: 'UTC' }));
}

// ============================================================
// Helper: Buscar dados do usuário (cidade/estado para feriados)
// ============================================================
async function getUserById(userId: number) {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('city, state')
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return data;
}

// ============================================================
// Helper: Calcular próxima data para lembrete recorrente
// ============================================================
function calculateNextDate(currentDate: Date, frequency: string): Date {
  const next = new Date(currentDate);
  switch (frequency) {
    case 'daily':
      next.setDate(next.getDate() + 1);
      break;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      break;
  }
  return next;
}

// ============================================================
// ENDPOINT PRINCIPAL (chamado pelo cron a cada minuto)
// ============================================================
export async function GET(request: Request) {
  // Proteção: só aceita chamadas internas ou com cron secret
  const authHeader = request.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (expected && authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const nowISO = now.toISOString();

  // 1. Buscar lembretes pendentes com scheduled_time já passada
  const { data: reminders, error } = await supabase
    .from('reminders')
    .select('*')
    .eq('status', 'pending')
    .not('scheduled_time', 'is', null)
    .lt('scheduled_time', nowISO);

  if (error) {
    console.error('[Worker] Erro ao buscar lembretes:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let processed = 0;
  let skippedHoliday = 0;
  let skippedDisabled = 0;
  let skippedQuiet = 0;
  let skippedDailyLimit = 0;
  let skippedLowRelevance = 0;

  for (const reminder of reminders) {
    // 2. Verificar feriado (nacional e municipal)
    const userProfile = await getUserById(reminder.user_id);
    if (!userProfile) continue;

    const reminderDate = new Date(reminder.scheduled_time);
    const isHoliday =
      (await isNationalHoliday(reminderDate)) ||
      (userProfile.city &&
        userProfile.state &&
        (await isMunicipalHoliday(reminderDate, userProfile.city, userProfile.state)));

    if (isHoliday) {
      await supabase
        .from('reminders')
        .update({ status: 'cancelled', metadata: { skipped_holiday: true } })
        .eq('id', reminder.id);
      skippedHoliday++;
      continue;
    }

    // 3. Obter preferências do usuário para push
    const prefs = await getUserPushPreferences(reminder.user_id);
    if (!prefs.enabled) {
      console.log(`[Worker] Push desabilitado para user ${reminder.user_id}`);
      skippedDisabled++;
      continue;
    }

    // 4. Verificar horário de silêncio
    const userTimezone = await getUserTimezone(reminder.user_id);
    if (isQuietTime(now, prefs.quiet_start, prefs.quiet_end, userTimezone)) {
      // Reagendar para o próximo horário fora do silêncio
      const nextTime = calculateNextQuietEnd(now, prefs.quiet_end, userTimezone);
      await supabase
        .from('reminders')
        .update({ scheduled_time: nextTime.toISOString() })
        .eq('id', reminder.id);
      console.log(`[Worker] Lembrete ${reminder.id} reagendado para fora do silêncio: ${nextTime.toISOString()}`);
      skippedQuiet++;
      continue;
    }

    // 5. Verificar limite diário de notificações push
    const todayCount = await getTodayPushCount(reminder.user_id);
    if (todayCount >= prefs.max_per_day) {
      console.log(`[Worker] Limite diário (${prefs.max_per_day}) atingido para user ${reminder.user_id}`);
      // Opcional: reagendar para o dia seguinte
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(8, 0, 0, 0); // 8h da manhã
      await supabase
        .from('reminders')
        .update({ scheduled_time: tomorrow.toISOString() })
        .eq('id', reminder.id);
      skippedDailyLimit++;
      continue;
    }

    // 6. Verificar relevância mínima (se o lembrete tiver campo relevance_score)
    const relevance = reminder.relevance_score ?? 0.5; // padrão 0.5
    if (prefs.min_relevance_score > 0 && relevance < prefs.min_relevance_score) {
      console.log(`[Worker] Relevância ${relevance} < ${prefs.min_relevance_score} para lembrete ${reminder.id}`);
      skippedLowRelevance++;
      continue;
    }

    // 7. Enviar push notification
    const pushSent = await sendPushNotification(reminder.user_id, reminder.title);

    // 8. Atualizar status do lembrete
    const newStatus = pushSent ? 'triggered' : 'failed';
    await supabase
      .from('reminders')
      .update({ status: newStatus, updated_at: nowISO })
      .eq('id', reminder.id);

    // 9. Registrar log na tabela notifications_log
    await supabase.from('notifications_log').insert({
      user_id: reminder.user_id,
      type: 'event_reminder',
      channel: 'push',
      message: reminder.title,
      reference_id: reminder.id,
      reference_type: 'reminder',
      sent_at: nowISO,
      // dedup_key pode ser usado para evitar duplicatas em execuções simultâneas
      dedup_key: `${reminder.id}_${nowISO}`,
    });

    // 10. Se for recorrente, criar nova instância para o próximo ciclo
    if (reminder.type === 'recurring' && reminder.frequency) {
      const nextDate = calculateNextDate(reminderDate, reminder.frequency);
      await supabase.from('reminders').insert({
        user_id: reminder.user_id,
        title: reminder.title,
        type: 'recurring',
        frequency: reminder.frequency,
        scheduled_time: nextDate.toISOString(),
        status: 'pending',
        created_at: nowISO,
        updated_at: nowISO,
        relevance_score: reminder.relevance_score, // preserva o score
      });
    }

    processed++;
  }

  console.log(`[Worker] Processados: ${processed} | Feriado: ${skippedHoliday} | Desabilitado: ${skippedDisabled} | Silêncio: ${skippedQuiet} | Limite: ${skippedDailyLimit} | Baixa relevância: ${skippedLowRelevance}`);

  return NextResponse.json({
    processed,
    skipped: {
      holiday: skippedHoliday,
      disabled: skippedDisabled,
      quiet: skippedQuiet,
      dailyLimit: skippedDailyLimit,
      lowRelevance: skippedLowRelevance,
    },
  });
}