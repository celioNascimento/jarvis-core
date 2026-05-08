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
  scheduledTime?: string | null;
  cron?: string | null;
}

export async function scheduleReminderOnQStash(
  payload: ScheduleReminderPayload
): Promise<string | null> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
    ? process.env.NEXT_PUBLIC_APP_URL
    : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  console.log('[QStash] Usando baseUrl:', baseUrl);

  try {
    const publishOptions: any = {
      url: `${baseUrl}/api/reminders/fire`,
      body: payload,
      retries: 3,
    };

    if (payload.cron) {
      publishOptions.cron = payload.cron;
      console.log(`[QStash] Agendando recorrente: ${payload.cron}`);
    } else if (payload.scheduledTime) {
      const scheduledAt = new Date(payload.scheduledTime);
      const now = new Date();
      const delaySeconds = Math.floor((scheduledAt.getTime() - now.getTime()) / 1000);

      if (delaySeconds <= 0) {
        console.warn('[QStash] Lembrete no passado — disparando imediatamente');
      }
      publishOptions.delay = Math.max(0, delaySeconds);
      console.log(`[QStash] Agendado com delay: ${delaySeconds}s`);
    } else {
      publishOptions.delay = 0;
    }

    // ── CORREÇÃO DE TYPESCRIPT AQUI ──
    // Dizemos ao compilador para tratar 'res' como 'any' para evitar o erro de union type
    const res = await qstash.publishJSON(publishOptions) as any;
    
    return res.messageId || null;
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
