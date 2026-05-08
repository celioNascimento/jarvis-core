// lib/modules/modules/agenda.ts
import { supabase } from '@/lib/jarvis';
import type { ModuleDefinition } from '../types';

export const ModuloAgenda: ModuleDefinition = {
  id: 'agenda_lev',
  label: 'Agenda Interna (Lev)',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    always: true, // Agenda deve estar sempre no contexto
    contexts: ['agenda', 'evento'], // 👈 REMOVIDO o 'lembrete' daqui para respeitar a Tipagem
    keywords: /agenda|amanhã|hoje|semana|marcar|meus eventos|lembrete|me lembra|avisar/i
  },
  buildContextBlock: async (opts) => {
    try {
      const { data, error } = await supabase.rpc('get_calendar_context_for_jarvis', {
        p_user_id: Number(opts.userId),
        p_days: 7,
      });

      if (error || !data) return 'Nenhum compromisso na agenda interna para os próximos 7 dias.';

      return `[AGENDA INTERNA LEV - PRÓXIMOS DIAS]\n${data}`;
    } catch (e) {
      console.error('[ModuloAgenda] Erro:', e);
      return '';
    }
  },
  // ── Sincronia Total com tools-def.ts e tools-executor.ts ──
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
