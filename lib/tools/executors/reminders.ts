// lib/tools/executors/reminders.ts
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formata scheduled_time de forma segura.
 * Retorna string legível ou fallback descritivo se a data for nula/inválida.
 */
function formatScheduledTime(
  scheduled_time: string | null | undefined,
  frequency?: string
): string {
  if (!scheduled_time) {
    if (frequency) return `recorrência ${frequency}`;
    return 'horário a definir';
  }

  const date = new Date(scheduled_time);
  if (isNaN(date.getTime())) {
    console.warn('[Reminder] scheduled_time inválido:', scheduled_time);
    return scheduled_time; // devolve o raw se não conseguir parsear
  }

  return date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

/**
 * Garante que scheduled_time ou delay_minutes estejam presentes
 * para reminders do tipo 'temporary'. Lança erro descritivo antes
 * de chegar ao service (evita o throw genérico "Data inválida: null").
 */
function validateCreateParams(p: CreateParams): void {
  const type = p.type ?? 'temporary';

  if (type === 'temporary' && !p.scheduled_time && !p.delay_minutes) {
    throw new Error(
      'Para criar um lembrete pontual, informe scheduled_time ou delay_minutes.'
    );
  }

  if (type === 'recurring' && !p.frequency && !p.scheduled_time) {
    throw new Error(
      'Para criar um lembrete recorrente, informe frequency (daily, weekly, etc.).'
    );
  }
}

// ─── Executores ───────────────────────────────────────────────────────────────

export async function executeCreateReminder(
  p: CreateParams,
  authUserId: string,
  numericUserId: string,
  sessionId: string
): Promise<string> {
  try {
    // Valida antes de chamar o service — erro claro em vez de "Data inválida: null"
    validateCreateParams(p);

    const targetId = await getEffectiveUserId(authUserId, numericUserId);

    const result = await coreCriarLembrete(Number(targetId), authUserId, {
      title:          p.title ?? p.message ?? 'Lembrete',
      type:           p.type,
      scheduled_time: p.scheduled_time,
      delay_minutes:  p.delay_minutes,
      frequency:      p.frequency,
    });

    await invalidateMasterContextCache(Number(targetId), sessionId);

    const hora = formatScheduledTime(result.scheduled_time, result.frequency ?? p.frequency);

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
