// lib/modules/modules/projetos.ts
import { supabase } from '@/lib/jarvis';
import type { ModuleDefinition } from '../types';

export const ModuloProjetos: ModuleDefinition = {
  id: 'projetos_lev',
  label: 'Projetos e Tópicos',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    always: false,
    contexts: ['projeto'],
    keywords: /projeto|reforma|tópico|módulo|entry|ideia|dívida técnica|backlog|pendência|iniciativa|kanban|roadmap|tarefa do projeto/i,
  },

  buildContextBlock: async (opts) => {
    try {
      // Busca projetos ativos onde o usuário é membro
      const { data: memberships, error: mErr } = await supabase
        .schema('jarvis')
        .from('project_members')
        .select('project_id, role')
        .eq('user_id', Number(opts.userId))
        .eq('status', 'active');

      if (mErr || !memberships?.length) return '';

      const ids = memberships.map(m => m.project_id);
      const roleMap = Object.fromEntries(memberships.map(m => [m.project_id, m.role]));

      const { data: projects, error: pErr } = await supabase
        .schema('jarvis')
        .from('projects')
        .select('id, tag, name, description, status, updated_at')
        .in('id', ids)
        .in('status', ['em_desenvolvimento', 'em_pausa'])
        .order('updated_at', { ascending: false })
        .limit(10);

      if (pErr || !projects?.length) return '';

      // Para cada projeto, traz os tópicos raiz (sem parent)
      const topicBlocks = await Promise.all(
        projects.map(async proj => {
          const { data: topics } = await supabase
            .schema('jarvis')
            .from('project_topics')
            .select('id, tag, name')
            .eq('project_id', proj.id)
            .is('parent_id', null)
            .order('order_index', { ascending: true })
            .limit(8);

          const role = roleMap[proj.id];
          const roleLabel = role !== 'owner' ? ` [${role}]` : '';
          const header = `• ${proj.name ?? proj.tag} (${proj.tag})${roleLabel} [${proj.status}] — id: ${proj.id}`;
          const topicList = topics?.length
            ? '\n  Tópicos: ' + topics.map(t => `${t.name ?? t.tag} (id:${t.id})`).join(', ')
            : '';

          return header + topicList;
        })
      );

      return [
        '[PROJETOS ATIVOS]',
        topicBlocks.join('\n'),
        '',
        'Use listar_topicos(project_id) para ver subtópicos e listar_entries(project_id, topic_id) para ver o conteúdo de um tópico.',
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
  ],

  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 },
};