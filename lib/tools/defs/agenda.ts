export const agendaTools = [
  {
    type: 'function',
    function: {
      name: 'consultar_agenda',
      description: 'Consulta a agenda interna e sincroniza com calendários externos (Google/Outlook). Use para ver compromissos futuros.',
      parameters: {
        type: 'object',
        properties: {
          dias: { type: 'integer', description: 'Número de dias para a consulta (padrão: 7).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'salvar_evento',
      description: 'Salva um novo compromisso na agenda interna. Verifica conflitos automaticamente.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título claro do evento.' },
          event_date: { type: 'string', description: 'Data e hora no formato ISO (ex: 2026-05-15T14:00:00).' },
          category: { 
            type: 'string', 
            enum: ['health', 'work', 'school', 'family', 'personal'],
            description: 'Categoria do evento para organização visual.' 
          },
          notes: { type: 'string', description: 'Detalhes ou observações adicionais.' },
          reminderMinutes: { type: 'integer', description: 'Minutos de antecedência para o alerta (padrão: 30).' },
          force: { type: 'boolean', description: 'Se true, ignora avisos de conflito de horário.' }
        },
        required: ['title', 'event_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deletar_evento',
      description: 'Remove um evento da agenda interna buscando pelo título.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termo de busca para encontrar o evento a ser removido.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'criar_evento_agenda',
      description: 'Cria um evento especificamente no GOOGLE CALENDAR.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Título do evento no Google.' },
          startTime: { type: 'string', description: 'Data/Hora de início ISO.' },
          reminderMinutes: { type: 'integer', description: 'Lembrete em minutos.' },
        },
        required: ['summary', 'startTime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_emails_recentes',
      description: 'Busca os últimos emails do Gmail ou Outlook para contexto.',
      parameters: {
        type: 'object',
        properties: {
          filtro: { type: 'string', description: 'Termo para filtrar emails (ex: nome de empresa).' },
        },
      },
    },
  }
];