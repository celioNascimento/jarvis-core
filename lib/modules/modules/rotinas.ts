// lib/modules/modules/rotinas.ts
// V13.0.0 — Arquitetura V2 (Sinal de fumaça): Payload enxuto e injeção tática

import type { ModuleDefinition } from '../types';

export const ModuloRotinas: ModuleDefinition = {
  id: 'rotinas',
  label: 'Gestão de Rotinas e Hábitos',
  preferredModel: 'flash',
  plan: 'free',
  version: 'v2', // ← OFICIALMENTE V2
  trigger: {
    contexts: ['rotina', 'foco'],
    keywords: /rotina|hábito|costume|todo dia|sempre faço|manhã|tarde|noite|ancora|âncora|checkin/i,
    condition: (opts) => {
      const msg = opts.message.toLowerCase();
      return (msg.includes('hoje') || msg.includes('agora')) && 
             /rotina|hábito|checkin|âncora|ancora/.test(msg);
    }
  },

  buildContextBlock: async (opts) => {
    try {
      // ✅ Usa os dados já processados pelo God RPC (RAM)
      const routines = (opts as any).masterContext?.routines || [];
      if (!routines.length) return '';

      // V2: Contagem cirúrgica de pendências sem iterar múltiplos grupos
      const pendentes = routines.filter((r: any) => 
        r.checkin?.status !== 'done' && r.checkin?.status !== 'skipped'
      ).length;

      // Emite o sinal de fumaça com a instrução de comportamento embutida
      return `[Módulo: Rotinas] Há ${routines.length} rotina(s) mapeada(s) no masterContext (${pendentes} ainda pendente(s) hoje). Use a tool 'listar_rotinas' para consultar as âncoras exatas e sugerir o próximo passo, ou 'fazer_checkin_rotina' para registrar execuções.`;

    } catch (e) {
      console.error('[ModuloRotinas] Erro ao carregar rotinas:', e);
      return '';
    }
  },

  tools: ['listar_rotinas', 'gerenciar_rotina', 'fazer_checkin_rotina'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
