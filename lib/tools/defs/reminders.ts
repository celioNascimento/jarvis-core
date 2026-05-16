// lib/tools/defs/reminders.ts
export const remindersTools = [
  {
    type: 'function',
    function: {
      name: 'lembrete_criar',
      description: 'Cria um lembrete com agendamento. Quando o usuário pedir para ser lembrado de algo, execute IMEDIATAMENTE sem pedir confirmação. Suporta recorrência e dias úteis.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'O que deve ser lembrado.' },
          type: {
            type: 'string',
            enum: ['temporary', 'recurring', 'location'],
            description: 'Tipo do lembrete. Use "recurring" se houver frequência.'
          },
          scheduled_time: { type: 'string', description: 'Hora ou data específica (ex: "08:00" ou ISO completo).' },
          delay_minutes: { type: 'integer', description: 'Minutos a partir de agora (caso não haja hora fixa).' },
          frequency: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly', 'weekdays'],
            description: 'Frequência da repetição. "weekdays" pula finais de semana.'
          },
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