// lib/modules/modules/rotinas.ts
import type { ModuleDefinition } from '../types';
import { coreGetRoutines, coreGetCheckins } from '@/lib/services/routines.service';

export const ModuloRotinas: ModuleDefinition = {
  id: 'rotinas',
  label: 'Gestão de Rotinas e Hábitos',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['rotina', 'foco'],
    keywords: /rotina|hábito|costume|todo dia|sempre faço|manhã|tarde|noite|ancora|âncora|checkin/i,
    condition: (opts) => opts.message.toLowerCase().includes('hoje') || opts.message.toLowerCase().includes('agora')
  },
  
  buildContextBlock: async (opts) => {
    try {
      const targetId = Number(opts.userId);
      const todayStr = new Date().toISOString().split('T')[0];

      // Busca rotinas e check-ins do dia via SSOT
      const [routines, checkins] = await Promise.all([
        coreGetRoutines(targetId),
        coreGetCheckins(targetId, todayStr)
      ]);

      if (!routines || routines.length === 0) return '';

      const formatGroup = (title: string, period: string) => {
        const list = routines.filter((r: any) => r.period === period);
        if (!list.length) return '';

        const lines = list.map((r: any) => {
          const checkin = checkins.find((c: any) => c.routine_id === r.id);
          let statusIcon = '⏳ (Pendente)';
          if (checkin?.status === 'done') statusIcon = '✅ (Feito)';
          if (checkin?.status === 'skipped') statusIcon = '⏭️ (Pulado)';
          
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

      return `[MÓDULO DE ROTINAS ATIVO - STATUS DE HOJE]
Suas rotinas e o status atual:
${blocks.join('\n\n')}

INSTRUÇÃO: Use estas rotinas para dar previsibilidade. Se o usuário parecer perdido, sugira seguir a próxima âncora pendente (⏳). Elogie se ele já concluiu as tarefas (✅).`;
      
    } catch (e) {
      console.error('[ModuloRotinas] Erro ao carregar rotinas:', e);
      return '';
    }
  },

  // Ferramentas que este módulo habilita no cérebro do Jarvis
  tools: [
    'listar_rotinas', 
    'gerenciar_rotina', 
    'fazer_checkin_rotina'
  ],
  
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
