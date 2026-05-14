import { supabase } from '@/lib/jarvis';
import type { ModuleDefinition } from '../types';
import { getEffectiveUserId } from '../relationships/identity';

export const ModuloReminders: ModuleDefinition = {
  id: 'reminders_push',
  label: 'Lembretes e Notificações',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    always: false,
    contexts: ['lembrete', 'notificacao'],
    keywords: /lembrete|me lembra|avisar|daqui a pouco|notificar/i
  },
  buildContextBlock: async (opts) => {
    try {
      if ((opts as any).masterContext?.reminders) {
        // Formata os lembretes do masterContext se existirem
        const rems = (opts as any).masterContext.reminders;
        if (!rems || rems.length === 0) return 'Nenhum lembrete pendente.';
        return `[LEMBRETES PENDENTES]\n${rems.map((r: any) => `- ${r.title} (${r.scheduled_time})`).join('\n')}`;
      }
      return 'Contexto de lembretes não carregado.';
    } catch (e) {
      return '';
    }
  },
  tools: [
    'create_reminder',
    'cancelar_lembrete',
    'consultar_lembretes'
  ],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};