// lib/modules/modules/financas.ts
// V12.3.0 — Injeção de Contexto e Fallback de Hidratação

import { buildFinanceBlock } from '@/lib/finances/db';
import type { ModuleDefinition } from '../types';

export const ModuloFinancas: ModuleDefinition = {
  id: 'financas',
  label: 'Gestão Financeira Inteligente',
  preferredModel: 'flash',
  plan: 'personal',
  trigger: {
    contexts: ['financas'],
    keywords: /gastei|paguei|recebi|dinheiro|valor|saldo|extrato|pix|conta|cartão|fatura/i,
    condition: (opts) => opts.message.toLowerCase().includes('resumo') || opts.message.toLowerCase().includes('hoje')
  },
  
  buildContextBlock: async (opts) => {
    try {
      // 1. Tenta a Injeção de Contexto (Zero DB Calls se o SQL já trouxer montado)
      // Ideal se no futuro você colocar o resumo financeiro direto no get_consolidated_context
      let block = (opts as any).masterContext?.finance_block;

      // 2. Fallback de Segurança (Se chamado isoladamente ou não injetado)
      if (!block) {
        block = await buildFinanceBlock(Number(opts.userId), opts.authUserId);
      }
      
      if (!block) return '';

      return `[CONTEXTO FINANCEIRO ATIVO]
${block}

INSTRUÇÃO: Use estes dados para responder de forma precisa. Se o usuário perguntar algo que não está aqui, sugira usar a ferramenta 'consultar_financas' para um período diferente.`;
    } catch (e) {
      console.error('[ModuloFinancas] Erro ao construir bloco:', e);
      return '';
    }
  },
  
  tools: [
    'registrar_transacao', 
    'consultar_financas', 
    'criar_orcamento', 
    'listar_orcamentos'
  ],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};