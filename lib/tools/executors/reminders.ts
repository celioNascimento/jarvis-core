// lib/tools/executors/reminders.ts  (refatorado)
// Responsabilidade: adaptar tool call → service → string de resposta
// TODA lógica de negócio fica em reminders.service.ts

import {
  coreConsultarLembretes,
  coreCriarLembrete,
  coreCancelarLembrete,
} from '@/lib/services/reminders.service';
import { getEffectiveUserId } from '@/lib/modules/relationships';
import { invalidateMasterContextCache } from '@/lib/chat/pipeline/intelligence';

type CreateParams = {
  title?: string;
  message?: string;  // alias legado — LLM às vezes manda "message" em vez de "title"
  type?: 'temporary' | 'recurring' | 'location';
  scheduled_time?: string;
  delay_minutes?: number;
  frequency?: 'daily' | 'weekly' | 'monthly' | 'weekdays';
};

export async function executeCreateReminder(
  p: CreateParams,
  authUserId: string,
  numericUserId: string,
  sessionId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);

    const result = await coreCriarLembrete(Number(targetId), authUserId, {
      title:          p.title ?? p.message ?? 'Lembrete',
      type:           p.type,
      scheduled_time: p.scheduled_time,
      delay_minutes:  p.delay_minutes,
      frequency:      p.frequency,
    });

    await invalidateMasterContextCache(Number(targetId), sessionId);

    const hora = new Date(result.scheduled_time).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
    });

    return `⏰ Lembrete "${result.title}" agendado para ${hora}.`;
  } catch (err: any) {
    console.error('[executeCreateReminder]', err);
    return `Erro ao criar lembrete: ${err.message}`;
  }
}

export async function executeConsultarLembretes(
  _p: unknown,
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    return await coreConsultarLembretes(Number(targetId));
  } catch (err: any) {
    console.error('[executeConsultarLembretes]', err);
    return `Erro ao consultar lembretes: ${err.message}`;
  }
}

export async function executeCancelarLembrete(
  p: { query: string },
  authUserId: string,
  numericUserId: string,
  sessionId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const title = await coreCancelarLembrete(Number(targetId), p.query);

    await invalidateMasterContextCache(Number(targetId), sessionId);

    return title.startsWith('Nenhum') ? title : `⏰ Lembrete "${title}" cancelado.`;
  } catch (err: any) {
    console.error('[executeCancelarLembrete]', err);
    return `Erro ao cancelar lembrete: ${err.message}`;
  }
}