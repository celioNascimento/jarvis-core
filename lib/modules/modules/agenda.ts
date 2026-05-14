// lib/modules/modules/agenda.ts
// V12 — Blindado com Injeção de Contexto Estrita
import { supabase } from '@/lib/jarvis';
import type { ModuleDefinition } from '../types';
import { getEffectiveUserId } from '../relationships/identity';

export const ModuloAgenda: ModuleDefinition = {
  id: 'agenda_lev',
  label: 'Agenda Interna (Lev)',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    always: true,
    contexts: ['agenda', 'evento'],
    keywords: /agenda|amanhã|hoje|semana|marcar|meus eventos|lembrete|me lembra|avisar/i
  },
  buildContextBlock: async (opts) => {
    try {
      // ✅ Usa SEMPRE o masterContext se ele existir. Zera a latência.
      if ((opts as any).masterContext?.calendar) {
        return `[AGENDA INTERNA LEV - PRÓXIMOS DIAS]\n${(opts as any).masterContext.calendar}`;
      }

      const targetId = await getEffectiveUserId(opts.userId, opts.userId);

      const { data, error } = await supabase.rpc('get_calendar_context_for_jarvis', {
        p_user_id: Number(targetId),
        p_days: 7,
      });

      if (error || !data) return 'Nenhum compromisso na agenda interna para os próximos 7 dias.';

      return `[AGENDA INTERNA LEV - PRÓXIMOS DIAS]\n${data}`;
    } catch (e) {
      console.error('[ModuloAgenda] Erro:', e);
      return '';
    }
  },
  tools: [
    'salvar_evento', 
    'consultar_agenda',
    'deletar_evento',
    'create_reminder',
    'cancelar_lembrete',
    'consultar_lembretes'
  ],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
