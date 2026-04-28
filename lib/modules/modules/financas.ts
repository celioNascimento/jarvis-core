// lib/modules/modules/financas.ts
import { buildFinanceBlock } from '@/lib/finances/db';
import type { ModuleDefinition } from '../types';

export const ModuloFinancas: ModuleDefinition = {
  id: 'financas',
  label: 'Gestão Financeira Inteligente',
  preferredModel: 'flash', // O Flash 2.0 é excelente para extração de valores
  plan: 'personal',        // Módulo restrito ao plano Personal ou superior
  trigger: {
    // Ativa quando a L4 detecta o contexto ou por palavras-chave
    contexts: ['financas'],
    keywords: /gastei|paguei|recebi|dinheiro|valor|saldo|extrato|pix|conta|cartão|fatura/i,
    // Sempre carrega um resumo básico se o usuário perguntar "Como estou hoje?"
    condition: (opts) => opts.message.toLowerCase().includes('resumo') || opts.message.toLowerCase().includes('hoje')
  },
  buildContextBlock: async (opts) => {
    try {
      // Reutiliza a sua função buildFinanceBlock do db.ts
      // Ela já entrega: Resumo do mês, Top gastos e alertas de orçamentos
      const block = await buildFinanceBlock(Number(opts.userId), opts.authUserId);
      
      if (!block) return '';

      return `[CONTEXTO FINANCEIRO ATIVO]
${block}

INSTRUÇÃO: Use estes dados para responder de forma precisa. Se o usuário perguntar algo que não está aqui, sugira usar a ferramenta 'consultar_financas' para um período diferente.`;
    } catch (e) {
      console.error('[ModuloFinancas] Erro ao construir bloco:', e);
      return '';
    }
  },
  // Ferramentas autorizadas para este módulo
  tools: [
    'registrar_transacao', 
    'consultar_financas', 
    'criar_orcamento', 
    'listar_orcamentos'
  ],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
