// lib/chat/pipeline/extractors/reminders.extractor.ts

import { callOpenRouter } from '@/lib/jarvis';
import { coreCriarLembrete } from '@/lib/services/reminders.service';

const CLEAN_JSON = (raw: string) => raw.replace(/```(?:json)?\r?\n?/g, '').trim();

const REMINDER_INTENT_SIGNALS = [
  /me lembra|lembrar|lembre(-me)?|não (esquecer|esqueça)/i,
  /avisar|notificar|alertar/i,
  /daqui a \d+|amanhã|semana que vem|toda (segunda|terça|quarta|quinta|sexta)/i,
];

export function hasReminderIntent(message: string): boolean {
  return REMINDER_INTENT_SIGNALS.some(p => p.test(message));
}

export async function extractReminder(
  userId: string,
  authUserId: string,
  userMessage: string,
  nowISO: string
): Promise<void> {
  if (!hasReminderIntent(userMessage)) return;

  const prompt = `Extraia o lembrete desta mensagem: "${userMessage}". Agora: ${nowISO}.
Retorne somente JSON: {"found":true,"title":"descrição","scheduled_time":"HH:MM ou ISO ou null","delay_minutes":null,"frequency":null}.
Para "daqui a N minutos", preencha somente delay_minutes com N e scheduled_time como null. Para horário fixo, preencha scheduled_time. Não invente horários.`;

  try {
    const parsed = JSON.parse(CLEAN_JSON(await callOpenRouter(prompt, 'google/gemini-2.5-flash', 0.1, 4)));
    if (!parsed?.found || !parsed?.title) return;
    await coreCriarLembrete(Number(userId), authUserId, {
      title: parsed.title,
      scheduled_time: parsed.delay_minutes != null ? undefined : parsed.scheduled_time ?? undefined,
      delay_minutes: parsed.delay_minutes != null ? Number(parsed.delay_minutes) : undefined,
      frequency: parsed.frequency ?? undefined,
    });
  } catch (error) {
    console.error('[Extrator/Reminder] Erro:', error);
  }
}

