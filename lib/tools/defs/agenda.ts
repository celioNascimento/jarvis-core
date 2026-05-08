// Definições de ferramentas: Agenda, Lembretes e Integrações de Calendário

export const agendaTools = [
  // ── AGENDA LEV (PROPRIEDADE JARVIS) ────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'consultar_agenda',
      description: 'Consulta a Agenda Mestra (Lev/Supabase) e sincroniza com Google/Outlook. Única fonte para ver compromissos.',
      parameters: {
        type: 'object',
        properties: {
          dias: { type: 'integer', description: 'Número de dias para frente (padrão 7)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'salvar_evento',
      description: 'Salva um compromisso na agenda interna do app (jarvis.events).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título do evento' },
          event_date: { type: 'string', description: 'Data e hora ISO 8601, ex: 2026-05-08T09:00:00-03:00' },
          category: { type: 'string', description: 'Categoria: health, work, school, family, personal' },
          notes: { type: 'string', description: 'Observações' },
          reminderMinutes: { type: 'integer', description: 'Antecedência do lembrete (padrão 30)' },
        },
        required: ['title', 'event_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deletar_evento',
      description: 'Remove um evento da agenda interna baseado no título.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Título ou parte do título do evento' },
        },
        required: ['query'],
      },
    },
  },

  // ── MOTOR DE LEMBRETES ──────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description: "Cria um lembrete (tempo ou local). Use quando ouvir 'me lembra' ou 'avisa'.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          type: { type: 'string', enum: ['temporary', 'agenda', 'recurring', 'location'] },
          delay_minutes: { type: 'integer' },
          scheduled_time: { type: 'string' },
          frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'weekdays'] },
          location_trigger: { type: 'string' },
        },
        required: ['title', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_lembretes',
      description: 'Lista todos os lembretes pendentes do usuário.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancelar_lembrete',
      description: 'Cancela um lembrete pendente baseado no título.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Título ou parte do título do lembrete' },
        },
        required: ['query'],
      },
    },
  },

  // ── GOOGLE CALENDAR ─────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'criar_evento_agenda',
      description: 'Cria evento NO GOOGLE CALENDAR (apenas sob pedido explícito).',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          startTime: { type: 'string' },
          reminderMinutes: { type: 'integer' },
        },
        required: ['summary', 'startTime'],
      },
    },
  },
];