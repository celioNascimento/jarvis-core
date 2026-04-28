// lib/modules/modules/rotinas.ts
import { supabase } from '@/lib/jarvis';
import type { ModuleDefinition } from '../types';

export const ModuloRotinas: ModuleDefinition = {
  id: 'rotinas',
  label: 'Gestão de Rotinas e Hábitos',
  preferredModel: 'flash',
  plan: 'free', // Rotinas são essenciais para o suporte TDAH, plano free.
  trigger: {
    // Ativa em contextos de rotina ou quando se fala de hábitos e horários
    contexts: ['rotina', 'foco'],
    keywords: /rotina|hábito|costume|todo dia|sempre faço|manhã|tarde|noite|ancora|âncora/i,
    // Sempre carrega se o usuário perguntar o que tem para fazer "hoje"
    condition: (opts) => opts.message.toLowerCase().includes('hoje') || opts.message.toLowerCase().includes('agora')
  },
  buildContextBlock: async (opts) => {
    try {
      // Busca rotinas ativas do usuário
      const { data: routines, error } = await supabase
        .from('routines')
        .select('anchor, action, period')
        .eq('user_id', opts.userId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      if (error) throw error;
      if (!routines || routines.length === 0) return '';

      // Organiza por período para o Jarvis entender a cronologia
      const morning = routines.filter(r => r.period === 'morning');
      const afternoon = routines.filter(r => r.period === 'afternoon');
      const evening = routines.filter(r => r.period === 'evening');
      const anytime = routines.filter(r => r.period === 'anytime');

      const formatGroup = (title: string, list: any[]) => 
        list.length > 0 ? `* ${title}:\n${list.map(r => `  - [${r.anchor}] -> ${r.action}`).join('\n')}` : '';

      const blocks = [
        formatGroup('MANHÃ', morning),
        formatGroup('TARDE', afternoon),
        formatGroup('NOITE', evening),
        formatGroup('QUALQUER MOMENTO', anytime)
      ].filter(Boolean);

      return `[MÓDULO DE ROTINAS ATIVO]
Suas rotinas configuradas para hoje:
${blocks.join('\n\n')}

INSTRUÇÃO: Use estas rotinas para dar previsibilidade ao usuário. Se ele parecer perdido, sugira seguir a próxima âncora disponível.`;
      
    } catch (e) {
      console.error('[ModuloRotinas] Erro ao carregar rotinas:', e);
      return '';
    }
  },
  // Ferramentas que este módulo habilita no cérebro do Jarvis
  tools: ['criar_rotina'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};