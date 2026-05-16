// lib/modules/modules/foco.ts
import type { ModuleDefinition } from '../types';
import { coreGetFocusSummary } from '@/lib/services/tdah.service';

export const ModuloFoco: ModuleDefinition = {
  id: 'foco',
  label: 'Suporte Executivo (TDAH)',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['foco'],
    keywords: /prioridade|urgente|eisenhower|quadrante|focar|tarefa|estou travado|pomodoro|despejo mental/i
  },
  
  buildContextBlock: async (opts) => {
    try {
      // Usa a SSOT para resgatar o panorama completo (Matriz + Sessões + Brain Dumps)
      const summary = await coreGetFocusSummary(Number(opts.userId));
      return summary;
    } catch (err) {
      console.error('[ModuloFoco] Erro ao carregar contexto:', err);
      return '[Erro ao carregar contexto de Foco e TDAH]';
    }
  },

  // Nomes exatos conforme registrados no lib/tools/defs/tdah.ts
  tools: [
    'tdah_gerenciar_eisenhower', 
    'tdah_quebrar_tarefa', 
    'tdah_registrar_despejo_mental',
    'tdah_registrar_sessao_foco',
    'tdah_consultar_resumo'
  ],
  
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
