// lib/qstash.ts
import { Client } from '@upstash/qstash';

export const qstash = new Client({
  token: process.env.QSTASH_TOKEN!,
});

export interface ScheduleReminderPayload {
  reminderId: string;
  userId: string;
  authUserId: string;
  message: string;
  scheduledTime: string;
}

export async function scheduleReminderOnQStash(
  payload: ScheduleReminderPayload
): Promise<string | null> {
  const scheduledAt = new Date(payload.scheduledTime);
  const now = new Date();
  const delaySeconds = Math.floor((scheduledAt.getTime() - now.getTime()) / 1000);

  if (delaySeconds <= 0) {
    console.warn('[QStash] Lembrete no passado — disparando imediatamente');
  }

  // Bug corrigido: parênteses garantem precedência correta
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
    ? process.env.NEXT_PUBLIC_APP_URL
    : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  console.log('[QStash] Usando baseUrl:', baseUrl);

  try {
    const res = await qstash.publishJSON({
      url: `${baseUrl}/api/reminders/fire`,
      delay: Math.max(0, delaySeconds),
      body: payload,
      retries: 3,
    });
    console.log('[QStash] Agendado:', res.messageId, '— delay:', delaySeconds, 's');
    return res.messageId;
  } catch (err) {
    console.error('[QStash] Erro ao agendar:', err);
    return null;
  }
}

export async function cancelReminderOnQStash(qstashMessageId: string): Promise<void> {
  try {
    await qstash.messages.delete(qstashMessageId);
    console.log('[QStash] Cancelado:', qstashMessageId);
  } catch (err) {
    console.error('[QStash] Erro ao cancelar:', err);
  }
}