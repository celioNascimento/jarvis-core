// lib/tools/extractors/reminders.extractor.ts
// Extração passiva de intenções de lembrete no pipeline de chat

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

export interface ExtractedReminder {
  title: string;
  scheduled_time?: string;
  delay_minutes?: number;
  frequency?: 'daily' | 'weekly' | 'monthly' | 'weekdays';
}

export async function extractReminder(
  userId: string,
  authUserId: string,
  userMessage: string,
  nowISO: string // injeta o "agora" do sistema para evitar drift de fuso
): Promise<void> {
  // Só extrai se houver sinal claro — evita falsos positivos
  if (!hasReminderIntent(userMessage)) return;

  const prompt = `
Você é um extrator de lembretes. Analise a mensagem e extraia a intenção de lembrete.
Mensagem: "${userMessage}"
Agora (ISO, fuso Brasília): ${nowISO}

Retorne APENAS JSON válido, sem markdown:
{
  "found": true | false,
  "title": "descrição clara do lembrete",
  "scheduled_time": "HH:MM ou ISO completo ou null",
  "delay_minutes": número inteiro ou null,
  "frequency": "daily" | "weekly" | "monthly" | "weekdays" | null
}

Regras:
- Se o usuário disse "daqui a 30 minutos", use delay_minutes: 30
- Se disse "às 10h", use scheduled_time: "10:00"
- Se disse "todo dia útil", use frequency: "weekdays"
- Se não há intenção clara de lembrete, retorne found: false
`.trim();

  try {
    const raw = await callOpenRouter(prompt, 'google/gemini-2.0-flash-001', 0.1, 4);
    const parsed = JSON.parse(CLEAN_JSON(raw));

    if (!parsed?.found || !parsed?.title) return;

    await coreCriarLembrete(Number(userId), authUserId, {
      title:          parsed.title,
      scheduled_time: parsed.scheduled_time ?? undefined,
      delay_minutes:  parsed.delay_minutes   ?? undefined,
      frequency:      parsed.frequency       ?? undefined,
    });

    console.log('[Extrator/Reminder] Criado passivamente:', parsed.title);
  } catch (e) {
    console.error('[Extrator/Reminder] Erro:', e);
  }
}