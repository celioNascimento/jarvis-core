// lib/finances/tools.ts
// Definições de ferramentas de finanças para o chat/route.ts
// Adicionar ao array `tools` em lib/chat/tools-def.ts

export const financeToolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'registrar_transacao',
      description:
        'Registra uma transação financeira (despesa, receita ou transferência). ' +
        'Chamar quando o usuário mencionar que gastou, pagou, recebeu, comprou algo com valor monetário. ' +
        'Ex: "gastei R$50 no mercado", "recebi meu salário", "paguei a academia".',
      parameters: {
        type: 'object',
        properties: {
          amount: {
            type: 'number',
            description: 'Valor da transação em reais (sempre positivo)',
          },
          type: {
            type: 'string',
            enum: ['expense', 'income', 'transfer_out', 'transfer_in'],
            description: 'expense=despesa, income=receita, transfer_out=transferência saída, transfer_in=entrada',
          },
          description: {
            type: 'string',
            description: 'Descrição da transação (curta, clara)',
          },
          transaction_date: {
            type: 'string',
            description: 'Data no formato YYYY-MM-DD. Omitir para hoje.',
          },
          category_name: {
            type: 'string',
            description: 'Nome da categoria (ex: Alimentação, Transporte, Saúde, Lazer, Moradia, Educação)',
          },
          merchant: {
            type: 'string',
            description: 'Nome do estabelecimento/pagador (ex: Mercado Extra, iFood, Empresa X)',
          },
          account_label: {
            type: 'string',
            description: 'Conta/cartão (ex: Nubank, Itaú, cartão de crédito). Omitir se não mencionado.',
          },
        },
        required: ['amount', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_financas',
      description:
        'Consulta resumo financeiro ou transações recentes do usuário. ' +
        'Chamar quando o usuário perguntar sobre gastos, saldo, quanto gastou em algo, ou pedir um resumo financeiro.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['today', 'week', 'month', 'last_month', 'year'],
            description: 'Período da consulta. Default: month',
          },
          category: {
            type: 'string',
            description: 'Filtrar por categoria específica (opcional)',
          },
          type: {
            type: 'string',
            enum: ['expense', 'income'],
            description: 'Filtrar por tipo (opcional)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'criar_orcamento',
      description:
        'Cria ou atualiza um orçamento mensal para uma categoria. ' +
        'Chamar quando o usuário quiser definir um limite de gastos por categoria. ' +
        'Ex: "quero gastar no máximo R$500 em alimentação esse mês".',
      parameters: {
        type: 'object',
        properties: {
          category_name: {
            type: 'string',
            description: 'Nome da categoria do orçamento',
          },
          amount: {
            type: 'number',
            description: 'Valor limite em reais',
          },
        },
        required: ['category_name', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_orcamentos',
      description:
        'Lista orçamentos ativos do mês atual com percentual de uso. ' +
        'Chamar quando o usuário perguntar sobre orçamentos, limites ou quiser ver como está o controle financeiro.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];