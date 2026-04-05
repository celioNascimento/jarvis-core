// app/api/reminders/worker/route.ts
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { sendPushNotification } from '@/lib/notifications/push';
import { isNationalHoliday, isMunicipalHoliday } from '@/lib/holiday';

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
  for (const reminder of reminders) {
    // 2. Verificar feriado (nacional e municipal)
    const user = await getUserById(reminder.user_id);
    if (!user) continue;

    const reminderDate = new Date(reminder.scheduled_time);
    const isHoliday = await isNationalHoliday(reminderDate) ||
      (user.city && user.state && await isMunicipalHoliday(reminderDate, user.city, user.state));

    if (isHoliday) {
      // Pular notificação e cancelar lembrete (ou reagendar, conforme política)
      await supabase
        .from('reminders')
        .update({ status: 'cancelled', metadata: { skipped_holiday: true } })
        .eq('id', reminder.id);
      continue;
    }

    // 3. Enviar push notification
    const pushSent = await sendPushNotification(reminder.user_id, reminder.title);

    // 4. Atualizar status do lembrete
    const newStatus = pushSent ? 'triggered' : 'failed';
    await supabase
      .from('reminders')
      .update({ status: newStatus, updated_at: nowISO })
      .eq('id', reminder.id);

    // 5. Registrar log (usando a tabela notifications_log existente)
    await supabase.from('notifications_log').insert({
      user_id: reminder.user_id,
      type: 'event_reminder',
      channel: 'push',
      message: reminder.title,
      reference_id: reminder.id,
      reference_type: 'reminder',
      sent_at: nowISO,
      // read_at fica null até o usuário interagir
    });

    // 6. Se for recorrente, criar nova instância para o próximo ciclo
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
      });
    }

    processed++;
  }

  return NextResponse.json({ processed });
}

// Helper: busca dados do usuário (cidade/estado para feriados)
async function getUserById(userId: number) {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('city, state')
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return data;
}

function calculateNextDate(currentDate: Date, frequency: string): Date {
  const next = new Date(currentDate);
  switch (frequency) {
    case 'daily': next.setDate(next.getDate() + 1); break;
    case 'weekly': next.setDate(next.getDate() + 7); break;
    case 'monthly': next.setMonth(next.getMonth() + 1); break;
  }
  return next;
}