// lib/modules/modules/reminders.ts
// V13.0.0 — Arquitetura V2 (Sinal de fumaça): Payload enxuto e Zero DB Calls

import { ModuleDefinition } from '../types';

export const ModuloReminders: ModuleDefinition = {
  id: 'reminders_push',
  label: 'Lembretes e Notificações',
  preferredModel: 'flash',
  plan: 'free',
  version: 'v2', // ← OFICIALMENTE V2
  
  trigger: {
    always: false,
    contexts: ['lembrete', 'notificacao'],
    keywords: /lembrete|me lembra|avisar|daqui a pouco|notificar|me avisa|não esquecer/i,
    condition: (opts) => {
      const reminders = (opts as any).masterContext?.reminders || [];
      const temKeyword = /lembrete|me lembra|avisar|notificar|me avisa/i.test(opts.message);
      return reminders.length > 0 && temKeyword;
    },
  },
  
  buildContextBlock: async (opts) => {
    try {
      // ✅ Injeção via masterContext (RAM)
      const reminders = (opts as any).masterContext?.reminders || [];
      
      // V2: Substituição da lista iterada pelo sinal de fumaça.
      return `[Módulo: Lembretes] Há ${reminders.length} lembrete(s) ativo(s) no masterContext. Para consultar os detalhes, alertas e horários, use a tool 'lembrete_consultar'. Para adicionar ou remover, use 'lembrete_criar' ou 'lembrete_cancelar'.`;
    } catch {
      return '';
    }
  },
  
  tools: ['lembrete_criar', 'lembrete_consultar', 'lembrete_cancelar'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
