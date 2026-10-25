// lib/tools/extractors/reminders.extractor.ts

const REMINDER_INTENT_SIGNALS = [
  /me lembra|lembrar|lembre(-me)?|não (esquecer|esqueça)/i,
  /avisar|notificar|alertar/i,
  /daqui a \d+|amanhã|semana que vem|toda (segunda|terça|quarta|quinta|sexta)/i,
];

export function hasReminderIntent(message: string): boolean {
  return REMINDER_INTENT_SIGNALS.some(p => p.test(message));
}

