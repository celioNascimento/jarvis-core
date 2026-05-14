// lib/modules/modules/agenda.ts
// V11 — Blindado com Injeção de Contexto (Zero DB calls padrão)
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
      // 1. Tenta extrair a agenda diretamente do masterContext já carregado! (Zero Latência)
      if (opts.masterContext?.calendar) {
        return `[AGENDA INTERNA LEV - PRÓXIMOS DIAS]\n${opts.masterContext.calendar}`;
      }

      // 2. Fallback resiliente: Caso o masterContext falhe ou se for um Alias ativo
      const targetId = await getEffectiveUserId(opts.userId, opts.userId);

      // Só faz a chamada se realmente precisar (Fallback de segurança)
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
