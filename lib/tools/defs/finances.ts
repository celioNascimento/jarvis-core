// Definições de ferramentas: Finanças

export const financesTools = [
  {
    type: 'function',
    function: {
      name: 'registrar_transacao',
      description: 'Registra despesa, receita ou transferência financeira.',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          type: { type: 'string', enum: ['expense', 'income', 'transfer_out', 'transfer_in'] },
          description: { type: 'string' },
          category_name: { type: 'string' },
          merchant: { type: 'string' },
          account_label: { type: 'string' },
          project_id: {
            type: 'string',
            description: 'Nome, tag ou UUID do projeto ao qual esta transação pertence. Use para materiais, serviços e custos do projeto.',
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
      description: 'Consulta resumo financeiro por período.',
      parameters: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['today', 'week', 'month', 'last_month', 'year'] },
          category: { type: 'string' },
          type: { type: 'string', enum: ['expense', 'income', 'transfer_out', 'transfer_in'] },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'financas_criar_orcamento',
      description: 'Cria um limite mensal de gastos para uma categoria.',
      parameters: {
        type: 'object',
        properties: {
          category_name: { type: 'string' },
          amount: { type: 'number', exclusiveMinimum: 0 },
        },
        required: ['category_name', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'financas_listar_orcamentos',
      description: 'Exibe limites de gastos por categoria.',
      parameters: { type: 'object', properties: {} },
    },
  },
];
