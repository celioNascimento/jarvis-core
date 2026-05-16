// lib/modules/modules/projetos.ts
import { supabase } from '@/lib/jarvis';
import type { ModuleDefinition } from '../types';
import { coreListarProjetos } from '@/lib/services/projects.service';

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
      // Usa a SSOT para buscar todos os projetos que o usuário pode ver
      const projects = await coreListarProjetos(Number(opts.userId));
      
      // Filtra apenas projetos ativos/em pausa
      const activeProjects = projects.filter((p: any) => 
        ['em_desenvolvimento', 'em_pausa'].includes(p.status)
      ).slice(0, 10);

      if (!activeProjects.length) return '';

      const topicBlocks = await Promise.all(
        activeProjects.map(async (proj: any) => {
          const { data: topics } = await supabase
            .schema('jarvis')
            .from('project_topics')
            .select('id, tag, name')
            .eq('project_id', proj.id)
            .is('parent_id', null)
            .order('order_index', { ascending: true })
            .limit(8);

          const roleLabel = proj.my_role !== 'owner' ? ` [Papel: ${proj.my_role}]` : '';
          const header = `• ${proj.name ?? proj.tag} (${proj.tag})${roleLabel} [Status: ${proj.status}] — id: ${proj.id}`;
          const topicList = topics?.length
            ? '\n  Tópicos Raiz: ' + topics.map(t => `${t.name ?? t.tag}`).join(', ')
            : '';

          return header + topicList;
        })
      );

      return [
        '[PROJETOS ATIVOS]',
        topicBlocks.join('\n'),
        '',
        'Comandos: listar_topicos(project_id) ou listar_entries(topic_id).',
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
