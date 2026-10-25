// lib/tools/defs/reminders.ts
export const remindersTools = [
  {
    type: 'function',
    function: {
      name: 'lembrete_consultar',
      description: 'Lista todos os lembretes pendentes. Use quando o usuário perguntar sobre lembretes ativos.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lembrete_cancelar',
      description: 'Cancela um lembrete pendente pelo título. Execute IMEDIATAMENTE sem pedir confirmação.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termo de busca para encontrar o lembrete.' },
        },
        required: ['query'],
      },
    },
  },
];
