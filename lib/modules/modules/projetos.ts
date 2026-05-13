// lib/modules/modules/projetos.ts
import { supabase } from '@/lib/jarvis';
import type { ModuleDefinition } from '../types';
import { getEffectiveUserId } from '../relationships/identity';

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
      // 1. Resolve o ID real para ler os projetos vinculados ao perfil do App
      const effectiveId = await getEffectiveUserId(opts.userId, opts.userId);

      // Busca projetos onde o usuário é membro (ou dono)
      const { data: memberships, error: mErr } = await supabase
        .from('project_members')
        .select('project_id, role')
        .eq('user_id', Number(effectiveId))
        .eq('status', 'active');

      if (mErr || !memberships?.length) return '';

      const ids = memberships.map(m => m.project_id);
      const roleMap = Object.fromEntries(memberships.map(m => [m.project_id, m.role]));

      const { data: projects, error: pErr } = await supabase
        .from('projects')
        .select('id, tag, name, description, status, updated_at')
        .in('id', ids)
        .in('status', ['em_desenvolvimento', 'em_pausa'])
        .order('updated_at', { ascending: false })
        .limit(10);

      if (pErr || !projects?.length) return '';

      const topicBlocks = await Promise.all(
        projects.map(async proj => {
          const { data: topics } = await supabase
            .from('project_topics')
            .select('id, tag, name')
            .eq('project_id', proj.id)
            .is('parent_id', null)
            .order('order_index', { ascending: true })
            .limit(8);

          const role = roleMap[proj.id];
          const roleLabel = role !== 'owner' ? ` [Papel: ${role}]` : '';
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