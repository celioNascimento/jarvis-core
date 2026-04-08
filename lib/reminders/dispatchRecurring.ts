import { supabase } from '@/lib/jarvis';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import { addDays, addWeeks, addMonths } from 'date-fns';

const expo = new Expo();

export async function dispatchRecurringReminders(): Promise<void> {
  const now = new Date();

  const { data: reminders, error } = await supabase
    .schema('jarvis')
    .from('reminders')
    .select(`id, title, frequency, scheduled_time, users!fk_reminders_user ( push_token )`)
    .eq('status', 'pending')
    .eq('type', 'recurring')
    .lte('scheduled_time', now.toISOString())
    .limit(100);

  if (error) {
    console.error('[Dispatch Recurring] Erro ao buscar reminders:', error.message);
    return;
  }

  if (!reminders?.length) return;

  const messages: ExpoPushMessage[] = [];
  const updates: { id: number; next: string }[] = [];

  for (const r of reminders) {
    const token = (r.users as any)?.push_token;
    if (!token || !Expo.isExpoPushToken(token)) {
      console.warn('[Dispatch Recurring] Token inválido para reminder:', r.id);
      continue;
    }

    messages.push({
      to: token,
      title: '🔁 Lembrete recorrente',
      body: r.title,
      sound: 'default',
      data: { reminderId: r.id },
    });

    const base = new Date(r.scheduled_time);
    const nextMap: Record<string, Date> = {
      daily:   addDays(base, 1),
      weekly:  addWeeks(base, 1),
      monthly: addMonths(base, 1),
    };
    const next = nextMap[r.frequency];
    if (next) updates.push({ id: r.id, next: next.toISOString() });
  }

  if (!messages.length) {
    console.log('[Dispatch Recurring] Nenhuma mensagem válida.');
    return;
  }

  // Envia em chunks
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      for (const receipt of receipts) {
        if (receipt.status === 'error') {
          console.error('[Dispatch Recurring] Erro no receipt:', receipt.message, receipt.details);
        }
      }
    } catch (err) {
      console.error('[Dispatch Recurring] Erro ao enviar chunk:', err);
    }
  }

  // Atualiza scheduled_time em paralelo
  await Promise.all(
    updates.map(({ id, next }) =>
      supabase
        .schema('jarvis')
        .from('reminders')
        .update({ scheduled_time: next, updated_at: new Date().toISOString() })
        .eq('id', id)
        .then(({ error }) => {
          if (error) console.error('[Dispatch Recurring] Erro ao reagendar id:', id, error.message);
        })
    )
  );

  console.log(`[Dispatch Recurring] Enviados: ${messages.length}`);
}