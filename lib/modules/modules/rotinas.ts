// lib/modules/modules/rotinas.ts
// V12.3.0 — Padrão Zero-Waste consolidado: Injeção de estado de check-in

import type { ModuleDefinition } from '../types';

export const ModuloRotinas: ModuleDefinition = {
  id: 'rotinas',
  label: 'Gestão de Rotinas e Hábitos',
  preferredModel: 'flash',
  plan: 'free',
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
      // ✅ Usa os dados já processados pelo God RPC (Zero DB Calls)
      const routines = (opts as any).masterContext?.routines || [];
      if (!routines.length) return '';

      const formatGroup = (title: string, period: string) => {
        const list = routines.filter((r: any) => r.period === period);
        if (!list.length) return '';

        const lines = list.map((r: any) => {
          let statusIcon = '⏳ (Pendente)';
          if (r.checkin?.status === 'done') statusIcon = '✅ (Feito)';
          if (r.checkin?.status === 'skipped') statusIcon = '⏭️ (Pulado)';

          return `  - [${r.anchor}] -> ${r.action} ${statusIcon}`;
        });

        return `* ${title}:\n${lines.join('\n')}`;
      };

      const blocks = [
        formatGroup('MANHÃ', 'morning'),
        formatGroup('TARDE', 'afternoon'),
        formatGroup('NOITE', 'evening'),
        formatGroup('QUALQUER MOMENTO', 'anytime')
      ].filter(Boolean);

      return `[MÓDULO DE ROTINAS ATIVO - STATUS DE HOJE]\n${blocks.join('\n\n')}

INSTRUÇÃO: Use estas rotinas para dar previsibilidade. Se o usuário parecer perdido, sugira seguir a próxima âncora pendente (⏳). Elogie se ele já concluiu as tarefas (✅).`;

    } catch (e) {
      console.error('[ModuloRotinas] Erro ao carregar rotinas:', e);
      return '';
    }
  },

  tools: ['listar_rotinas', 'gerenciar_rotina', 'fazer_checkin_rotina'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};