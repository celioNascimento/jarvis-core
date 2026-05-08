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
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_orcamentos',
      description: 'Exibe limites de gastos por categoria.',
      parameters: { type: 'object', properties: {} },
    },
  },
];