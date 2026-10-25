// lib/tools/defs/reminders.ts
export const remindersTools = [
  {
    type: 'function',
    function: {
      name: 'lembrete_criar',
      description: 'Cria um lembrete imediatamente. Use delay_minutes para expressões relativas como “daqui a 10 minutos” e scheduled_time somente para horários fixos.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'O que deve ser lembrado.' },
          type: { type: 'string', enum: ['temporary', 'recurring', 'location'] },
          scheduled_time: { type: 'string', description: 'Horário fixo em HH:MM ou data ISO. Não use para “daqui a X minutos”.' },
          delay_minutes: { type: 'integer', description: 'Intervalo em minutos a partir de agora.' },
          frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'weekdays'] },
        },
        required: ['title'],
      },
    },
  },
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
