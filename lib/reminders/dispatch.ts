// lib/reminders/dispatch.ts
import { supabase } from '@/lib/jarvis';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';

const expo = new Expo();

export async function dispatchPendingReminders(): Promise<void> {
  // Busca pendentes cujo horário já passou (temporary + agenda)
  const { data: reminders, error } = await supabase
    .from('reminders')
    .select(`
      id,
      title,
      type,
      frequency,
      scheduled_time,
      delay_minutes,
      users ( push_token )
    `)
    .eq('status', 'pending')
    .in('type', ['temporary', 'agenda'])
    .lte('scheduled_time', new Date().toISOString())
    .limit(100);

  if (error) {
    console.error('[Dispatch] Erro ao buscar reminders:', error.message);
    return;
  }

  if (!reminders?.length) return;

  const messages: ExpoPushMessage[] = [];
  const toComplete: number[] = [];   // temporary → 'completed'
  const toReschedule: { id: number; next: string }[] = []; // recurring → próxima data

  for (const r of reminders) {
    const token = (r.users as any)?.push_token;
    if (!token || !Expo.isExpoPushToken(token)) continue;

    messages.push({
      to: token,
      title: '🔔 Lembrete',
      body: r.title,
      sound: 'default',
      data: { reminderId: r.id, type: r.type },
    });

    toComplete.push(r.id);
  }

  // Envia em chunks
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      console.error('[Dispatch] Erro ao enviar chunk:', err);
    }
  }

  // Marca temporary/agenda como completed
  if (toComplete.length) {
    await supabase
      .from('reminders')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .in('id', toComplete);
  }

  console.log(`[Dispatch] Enviados: ${messages.length}`);
}