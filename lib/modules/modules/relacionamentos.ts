// lib/modules/modules/relacionamentos.ts
// V12.3.0 — Padrão Zero-Waste consolidado

import type { ModuleDefinition } from '../types';

export const ModuloRelacionamentos: ModuleDefinition = {
  id: 'relacionamentos',
  label: 'Contatos e Permissões',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['relacao'],
    keywords: /contato|permissão|compartilhar|acesso|liberar|bloquear|giselle/i 
  },
  
  buildContextBlock: async (opts) => {
    try {
      // ✅ Injeção via masterContext (Zero DB Calls)
      const rels = (opts as any).masterContext?.relationships;
      
      if (!rels || rels.length === 0) return '';

      return [
        '### 🤝 RELACIONAMENTOS (Permissões Ativas)',
        'Você possui conexões ativas. Se o usuário pedir para compartilhar algo, use a ferramenta alternar_permissao_contato se não estiver liberado.'
      ].join('\n');
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