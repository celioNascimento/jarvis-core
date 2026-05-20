// lib/modules/modules/projetos.ts
// V12.3.0 — Zero DB Calls, Tipagem rigorosa e Fallback de Hidratação

import { supabase } from '@/lib/jarvis';
import type { ModuleDefinition } from '../types';

interface Project {
  id: number;
  name: string;
  tag: string;
  status: string;
  my_role?: string;
}

export const ModuloProjetos: ModuleDefinition = {
  id: 'projetos_lev',
  label: 'Projetos e Tópicos',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    always: false,
    contexts: ['projeto', 'planejamento'],
    keywords: /projeto|reforma|tópico|módulo|entry|ideia|dívida técnica|backlog|pendência|iniciativa|kanban|roadmap|tarefa do projeto/i,
  },

  buildContextBlock: async (opts) => {
    try {
      // 1. Tenta a Injeção de Contexto (Zero DB Calls)
      let projects: Project[] = (opts as any).masterContext?.projects;

      // 2. Fallback de Segurança (Se chamado isoladamente)
      if (!projects) {
        const { data } = await supabase
          .schema('jarvis')
          .from('projects')
          .select('id, name, tag, status, my_role')
          .eq('user_id', opts.userId)
          .in('status', ['em_desenvolvimento', 'em_pausa'])
          .limit(10);
        
        projects = data || [];
      }

      if (!projects.length) return '';

      // 3. Montagem Enxuta (Deixa os detalhes para as tools)
      const topicBlocks = projects.map((proj: Project) => {
        const roleLabel = proj.my_role && proj.my_role !== 'owner' ? ` [Papel: ${proj.my_role}]` : '';
        return `• ${proj.name ?? proj.tag} (${proj.tag})${roleLabel} [Status: ${proj.status}] — id: ${proj.id}`;
      });

      return [
        '[PROJETOS ATIVOS]',
        topicBlocks.join('\n'),
        '',
        'INSTRUÇÃO: Para ver os tópicos de um projeto, use listar_topicos(project_id). Para ver tarefas, use listar_entries(topic_id).',
      ].join('\n');
    } catch (e) {
      console.error('[ModuloProjetos] Erro:', e);
      return '';
    }
  },

  tools: [
    'gerenciar_projeto',
    'listar_projetos',
    'gerenciar_topico',
    'listar_topicos',
    'gerenciar_entry',
    'listar_entries',
    'gerenciar_membros_projeto'
  ],

  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 },
};