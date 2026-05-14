export const remindersTools = [
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description: 'Cria um lembrete com agendamento via QStash. Suporta recorrência e inteligência de dias úteis.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'O que deve ser lembrado.' },
          type: { 
            type: 'string', 
            enum: ['temporary', 'recurring', 'location'],
            description: 'Tipo do lembrete. Use "recurring" se houver frequência.' 
          },
          scheduled_time: { type: 'string', description: 'Hora ou data específica (ex: "08:00" ou ISO).' },
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
      name: 'consultar_lembretes',
      description: 'Lista todos os lembretes que ainda não foram disparados.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancelar_lembrete',
      description: 'Cancela um lembrete pendente buscando pelo título.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termo de busca para encontrar o lembrete.' },
        },
        required: ['query'],
      },
    },
  }
];