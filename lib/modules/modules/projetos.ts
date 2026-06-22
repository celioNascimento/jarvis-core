// lib/modules/modules/projetos.ts
// V13.0.0 — STRICT REGRA 3: Sem Supabase + Arquitetura V2 (Sinal de fumaça)

import type { ModuleDefinition } from '../types';

export const ModuloProjetos: ModuleDefinition = {
  id: 'projetos_lev',
  label: 'Projetos e Tópicos',
  preferredModel: 'flash',
  plan: 'free',
  version: 'v2', // ← OFICIALMENTE V2
  trigger: {
    always: false,
    contexts: ['projeto', 'planejamento'],
    keywords: /projeto|reforma|tópico|módulo|entry|ideia|dívida técnica|backlog|pendência|iniciativa|kanban|roadmap|tarefa do projeto/i,
  },

  buildContextBlock: async (opts) => {
    try {
      // 1. Injeção de Contexto RIGOROSA (Zero DB Calls)
      // Fallback de Supabase foi removido para respeitar o contrato do Módulo
      const projects = (opts as any).masterContext?.projects;

      if (!projects || !projects.length) return '';

      // 2. V2: Apenas sinal de fumaça. Deixa a extração de dados para as tools.
      return `[Módulo: Projetos] O usuário possui ${projects.length} projeto(s) ativo(s) no masterContext. Use a tool 'listar_projetos' para ver a lista, 'listar_topicos' para ver tópicos de um projeto, ou 'listar_entries' para ver as tarefas.`;
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
