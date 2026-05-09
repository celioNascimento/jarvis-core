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

// lib/qstash.ts

export async function scheduleReminderOnQStash(
  payload: ScheduleReminderPayload
): Promise<string | null> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
    ? process.env.NEXT_PUBLIC_APP_URL
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';

  const destination = `${baseUrl}/api/reminders/fire`;
  console.log('[QStash] Destino:', destination);

  try {
    // ── CASE 1: AGENDAMENTO RECORRENTE (CRON) ──
    if (payload.cron) {
      console.log(`[QStash] Criando Schedule (Cron): ${payload.cron}`);

      const res = await qstash.schedules.create({
        destination,
        cron: payload.cron,

        body: JSON.stringify(payload),
        retries: 3,
      });

      return res.scheduleId;
    }

    // ── CASE 2: LEMBRETE ÚNICO (DELAY) ──
    const delaySeconds = payload.scheduledTime
      ? Math.max(0, Math.floor((new Date(payload.scheduledTime).getTime() - Date.now()) / 1000))
      : 0;

    console.log(`[QStash] Agendado com delay: ${delaySeconds}s`);

    // ✅ CORREÇÃO DE TIPAGEM: 
    // Usamos o tipo de retorno específico 'PublishToUrlResponse' para liberar o acesso ao 'messageId'
    const res = await qstash.publishJSON({
      url: destination,
      body: payload,
      delay: delaySeconds,
      retries: 3,
    }) as { messageId: string }; // 👈 Forçamos a tipagem aqui para o TS parar de reclamar

    return res.messageId;

  } catch (err) {
    console.error('[QStash] Erro crítico no transporte:', err);
    return null;
  }
}

export async function cancelReminderOnQStash(id: string): Promise<void> {
  try {
    // Tenta deletar como mensagem, se falhar tenta como schedule
    if (id.startsWith('msg_')) {
      await qstash.messages.delete(id);
    } else {
      await qstash.schedules.delete(id);
    }
    console.log('[QStash] Removido com sucesso:', id);
  } catch (err) {
    console.error('[QStash] Erro ao cancelar (pode já ter sido disparado):', id);
  }
}