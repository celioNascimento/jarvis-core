// lib/modules/modules/agenda.ts
// V13.1.0 — STRICT REGRA 3: Função Pura, Zero DB Calls + Arquitetura V2 (Sinal de fumaça)

import type { ModuleDefinition } from '../types';

export const ModuloAgenda: ModuleDefinition = {
  id: 'agenda_lev',
  label: 'Agenda Interna (Lev)',
  preferredModel: 'flash',
  plan: 'free',
  version: 'v2', // ← OFICIALMENTE V2
  trigger: {
    contexts: ['agenda', 'evento'],
    keywords: /agenda|amanhã|hoje|semana|marcar|meus eventos|compromisso|reunião|horário|cancelar|adiar/i,
    condition: (opts) => {
      // Verifica se há eventos injetados no masterContext (já carregados pelo RPC principal)
      const events = (opts as any).masterContext?.events || [];
      return events.length > 0;
    },
  },
  
  // REGRA 3 MANTIDA: Sem async, sem await, sem fetch, sem supabase. 
  // NOVA REGRA (Processador): Apenas emite o "sinal de fumaça" informando a IA para usar as tools.
  buildContextBlock: async (opts) => {
    try {
      const events = (opts as any).masterContext?.events || [];
      
      if (!events.length) return '';

      // V2: Não despejamos mais todos os detalhes de data, categoria e nome no prompt.
      // Damos apenas a métrica e a instrução clara de qual ferramenta usar.
      return `[Módulo: Agenda] O usuário tem ${events.length} evento(s) no masterContext. Use a tool 'agenda_consultar' para visualizar detalhes e horários, ou 'agenda_salvar_evento'/'agenda_deletar_evento' para modificações.`;
    } catch (e) {
      console.error('[ModuloAgenda] Erro ao construir bloco:', e);
      return '';
    }
  },
  
  tools: ['agenda_salvar_evento', 'agenda_consultar', 'agenda_deletar_evento'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
