import { supabase } from "@/lib/jarvis";
import { getEffectiveUserId } from "../relationships";
import { ModuleDefinition } from "../types";

// lib/modules/reminders.module.ts
export const ModuloReminders: ModuleDefinition = {
  id: 'reminders_push',
  label: 'Lembretes e Notificações',
  preferredModel: 'flash',
  plan: 'free',
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
      const reminders = (opts as any).masterContext?.reminders || [];
      if (!reminders.length) return '';

      const linhas = reminders.map((r: any) => {
        const hora = new Date(r.scheduled_time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const freq = r.frequency ? ` (${r.frequency})` : '';
        return `- ${r.title} → ${hora}${freq}`;
      }).join('\n');

      return `[LEMBRETES PENDENTES]\n${linhas}`;
    } catch {
      return '';
    }
  },
  tools: ['lembrete_criar', 'lembrete_consultar', 'lembrete_cancelar'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
