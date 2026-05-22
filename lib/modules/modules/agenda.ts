// lib/modules/modules/agenda.ts
// V13.0.0 — STRICT REGRA 3: Função Pura, Zero DB Calls

import type { ModuleDefinition } from '../types';

export const ModuloAgenda: ModuleDefinition = {
  id: 'agenda_lev',
  label: 'Agenda Interna (Lev)',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['agenda', 'evento'],
    keywords: /agenda|amanhã|hoje|semana|marcar|meus eventos|compromisso|reunião|horário|cancelar|adiar/i,
    condition: (opts) => {
      // Verifica se há eventos injetados no masterContext (já carregados pelo RPC principal)
      const events = (opts as any).masterContext?.events || [];
      return events.length > 0;
    },
  },
  
  // REGRA 3: Sem async, sem await, sem fetch, sem supabase. 
  // Apenas formata o que já está na memória RAM.
  buildContextBlock: (opts) => {
    try {
      const events = (opts as any).masterContext?.events || [];
      
      if (!events.length) return '';

      // Formata os eventos injetados de forma limpa para o LLM
      const linhas = events.map((e: any) => {
        // Ajusta para o fuso do Brasil na hora de exibir pro LLM
        const data = new Date(e.start_at).toLocaleString('pt-BR', { 
          timeZone: 'America/Sao_Paulo',
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
        });
        return `- ${e.title} (${data}) [Cat: ${e.category || 'personal'}]`;
      });

      return `[AGENDA INTERNA LEV - PRÓXIMOS EVENTOS]\n${linhas.join('\n')}`;
    } catch (e) {
      console.error('[ModuloAgenda] Erro ao construir bloco:', e);
      return '';
    }
  },
  
  tools: ['agenda_salvar_evento', 'agenda_consultar', 'agenda_deletar_evento'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
