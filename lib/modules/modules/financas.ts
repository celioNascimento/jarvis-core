// lib/modules/modules/financas.ts
// V12.4.0 — Zero DB Calls — dados financeiros apenas via tool sob demanda

import type { ModuleDefinition } from '../types';

export const ModuloFinancas: ModuleDefinition = {
  id: 'financas',
  label: 'Gestão Financeira Inteligente',
  preferredModel: 'flash',
  plan: 'personal',
  trigger: {
    contexts: ['financas'],
    keywords: /gastei|paguei|recebi|dinheiro|valor|saldo|extrato|pix|conta|cartão|fatura/i,
    condition: (opts) =>
      opts.message.toLowerCase().includes('resumo') ||
      opts.message.toLowerCase().includes('hoje'),
  },

  buildContextBlock: async (opts) => {
    try {
      // Lê exclusivamente do masterContext — zero queries
      // finance_block é gerado sob demanda pela tool consultar_financas
      // e pode ser injetado aqui no futuro via get_consolidated_context
      const block = (opts as any).masterContext?.finance_block;

      if (!block) return '';

      return `[CONTEXTO FINANCEIRO ATIVO]
${block}

INSTRUÇÃO: Use estes dados para responder de forma precisa. Se o usuário perguntar algo que não está aqui, use a ferramenta 'consultar_financas' para buscar um período específico.`;
    } catch (e) {
      console.error('[ModuloFinancas] Erro ao construir bloco:', e);
      return '';
    }
  },

  tools: [
    'registrar_transacao',
    'consultar_financas',
    'criar_orcamento',
    'listar_orcamentos',
  ],

  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 },
};
