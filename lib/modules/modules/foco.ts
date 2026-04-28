import { supabase } from '@/lib/jarvis';
import type { ModuleDefinition } from '../types';

export const ModuloFoco: ModuleDefinition = {
  id: 'foco',
  label: 'Suporte Executivo (TDAH)',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['foco'],
    keywords: /prioridade|urgente|eisenhower|quadrante|focar|tarefa|estou travado/i
  },
  buildContextBlock: async (opts) => {
    const { data: tasks } = await supabase.from('eisenhower_items').select('*').eq('user_id', opts.userId).eq('completed', false);
    if (!tasks?.length) return '';

    const qMap: any = { q1: '🔥 Crise/Urgente', q2: '📅 Planejamento', q3: '⚖️ Delegação', q4: '🗑️ Eliminar' };
    const lines = tasks.map(t => `[${qMap[t.quadrant] || 'S/Q'}] ${t.text}`);
    
    return `[MÓDULO FOCO — MATRIZ EISENHOWER]\n${lines.join('\n')}`;
  },
  tools: ['gerenciar_eisenhower', 'iniciar_sessao_foco', 'quebrar_tarefa'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
