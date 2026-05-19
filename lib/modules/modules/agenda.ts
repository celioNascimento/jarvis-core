import { supabase } from '@/lib/jarvis';
import type { ModuleDefinition } from '../types';
import { getEffectiveUserId } from '../relationships/identity';

export const ModuloAgenda: ModuleDefinition = {
  id: 'agenda_lev',
  label: 'Agenda Interna (Lev)',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    always: false,
    contexts: ['agenda', 'evento'],
    keywords: /agenda|amanhã|hoje|semana|marcar|meus eventos|compromisso|reunião|horário|cancelar|adiar/i,
    condition: (opts) => {
      const events = (opts as any).masterContext?.events || [];
      return events.length > 0;
    },
  },
  buildContextBlock: async (opts) => {
    try {
      const targetId = await getEffectiveUserId(opts.userId, opts.userId);
      const { data, error } = await supabase.rpc('get_calendar_context_for_jarvis', {
        p_user_id: Number(targetId),
        p_days: 7,
      });
      if (error || !data) return '';
      return `[AGENDA INTERNA LEV - PRÓXIMOS DIAS]\n${data}`;
    } catch {
      return '';
    }
  },
  tools: ['agenda_salvar_evento', 'agenda_consultar', 'agenda_deletar_evento'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
