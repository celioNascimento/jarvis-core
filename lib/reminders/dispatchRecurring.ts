// lib/reminders/dispatchRecurring.ts
import { supabase } from '@/lib/jarvis';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import { addDays, addWeeks, addMonths } from 'date-fns';

const expo = new Expo();

export async function dispatchRecurringReminders(): Promise<void> {
  const now = new Date();

  const { data: reminders, error } = await supabase
    .from('reminders')
    .select(`id, title, frequency, scheduled_time, users ( push_token )`)
    .eq('status', 'pending')
    .eq('type', 'recurring')
    .lte('scheduled_time', now.toISOString())
    .limit(100);

  if (error || !reminders?.length) return;

  const messages: ExpoPushMessage[] = [];
  const updates: { id: number; next: string }[] = [];

  for (const r of reminders) {
    const token = (r.users as any)?.push_token;
    if (!token || !Expo.isExpoPushToken(token)) continue;

    messages.push({
      to: token,
      title: '🔁 Lembrete recorrente',
      body: r.title,
      sound: 'default',
      data: { reminderId: r.id },
    });

    // Calcula próxima ocorrência
    const base = new Date(r.scheduled_time);
    const nextMap = {
      daily:   addDays(base, 1),
      weekly:  addWeeks(base, 1),
      monthly: addMonths(base, 1),
    };
    const next = nextMap[r.frequency as keyof typeof nextMap];

    if (next) {
      updates.push({ id: r.id, next: next.toISOString() });
    }
  }

  // Envia
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    await expo.sendPushNotificationsAsync(chunk);
  }

  // Atualiza scheduled_time para a próxima ocorrência (mantém pending)
  for (const { id, next } of updates) {
    await supabase
      .from('reminders')
      .update({ scheduled_time: next, updated_at: new Date().toISOString() })
      .eq('id', id);
  }

  console.log(`[Dispatch Recurring] Enviados: ${messages.length}`);
}