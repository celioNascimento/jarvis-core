// lib/tools/defs/agenda.ts
// Definições de ferramentas para Agenda Lev, Lembretes e Integrações

export const agendaTools = [
  // ── AGENDA INTERNA (LEV) ────────────────────────────────────────────────
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

  // ── MOTOR DE LEMBRETES (NOTIFICAÇÕES PUSH) ──────────────────────────────
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
  },

  // ── INTEGRAÇÕES EXTERNAS ────────────────────────────────────────────────
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
  },
];