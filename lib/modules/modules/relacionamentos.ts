// lib/modules/modules/relacionamentos.ts
// V13.0.0 — Padrão V2 (Sinal de fumaça) consolidado

import type { ModuleDefinition } from '../types';

export const ModuloRelacionamentos: ModuleDefinition = {
  id: 'relacionamentos',
  label: 'Contatos e Permissões',
  preferredModel: 'flash',
  plan: 'free',
  version: 'v2', // ← OFICIALMENTE V2
  trigger: {
    contexts: ['relacao'],
    keywords: /contato|permissão|compartilhar|acesso|liberar|bloquear|giselle/i 
  },
  
  buildContextBlock: async (opts) => {
    try {
      // ✅ Injeção via masterContext (Zero DB Calls)
      const rels = (opts as any).masterContext?.relationships;
      
      if (!rels || rels.length === 0) return '';

      // V2: Sinal de fumaça padronizado
      return `[Módulo: Relacionamentos] O usuário possui ${rels.length} conexão(ões) no masterContext. Para consultar detalhes ou liberar/bloquear acessos, use a tool 'alternar_permissao_contato'.`;
    } catch (e) {
      console.error('[ModuloRelacionamentos] Erro:', e);
      return '';
    }
  },

  tools: [
    'alternar_permissao_contato',
    'gerenciar_membros_projeto'
  ],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
