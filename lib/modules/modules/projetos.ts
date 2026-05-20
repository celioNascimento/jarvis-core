// lib/modules/modules/projetos.ts
// V12.1.0 — Eliminação de chamadas Supabase via Injeção de Contexto

import type { ModuleDefinition } from '../types';

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
      // ✅ 1. LEITURA VIA INJEÇÃO (Zero chamadas de rede)
      // O masterContext já contém a lista de projetos consolidada pelo RPC
      const projects = (opts as any).masterContext?.projects || [];
      
      const activeProjects = projects.filter((p: any) => 
        ['em_desenvolvimento', 'em_pausa'].includes(p.status)
      ).slice(0, 10);

      if (!activeProjects.length) return '';

      // ✅ 2. REMOÇÃO DO MAP COM SUPABASE
      // Não consultamos mais o banco aqui. 
      // Se você precisar dos tópicos, o RPC de consolidado deve trazê-los 
      // dentro do objeto de cada projeto.
      const topicBlocks = activeProjects.map((proj: any) => {
        const roleLabel = proj.my_role !== 'owner' ? ` [Papel: ${proj.my_role}]` : '';
        const header = `• ${proj.name ?? proj.tag} (${proj.tag})${roleLabel} [Status: ${proj.status}] — id: ${proj.id}`;
        
        // Se o RPC trouxer 'topics', usamos aqui. Se não, apenas listamos o projeto.
        const topicList = proj.topics?.length
          ? '\n  Tópicos Raiz: ' + proj.topics.map((t: any) => `${t.name ?? t.tag}`).join(', ')
          : '';

        return header + topicList;
      });

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
    'gerenciar_projeto', 'listar_projetos', 'gerenciar_topico',
    'listar_topicos', 'gerenciar_entry', 'listar_entries', 'gerenciar_membros_projeto'
  ],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 },
};
