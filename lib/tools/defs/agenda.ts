export const agendaTools = [
  {
    type: 'function',
    function: {
      name: 'agenda_consultar',
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
      name: 'agenda_salvar_evento',
      description: 'Salva um compromisso FORMAL na agenda. Quando o usuário pedir para agendar algo com título e horário claros, execute IMEDIATAMENTE sem pedir confirmação.',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Título claro do compromisso.' },
          data_hora: { type: 'string', description: 'Data e hora no formato ISO (ex: 2026-05-15T14:00:00).' },
          categoria: {
            type: 'string',
            enum: ['health', 'work', 'school', 'family', 'personal'],
            description: 'Categoria do evento para organização visual.'
          },
          notas: { type: 'string', description: 'Detalhes, links ou observações adicionais.' },
          minutos_lembrete: { type: 'integer', description: 'Minutos de antecedência para o alerta (padrão: 30).' },
          sincronizar_google: { type: 'boolean', description: 'Se true, cria o evento também no Google Calendar.' },
          forcar: {
            type: 'boolean',
            description: 'MUITO IMPORTANTE: O padrão é SEMPRE false. Use true APENAS se o usuário pedir explicitamente usando palavras como "force o agendamento" ou "ignore o aviso". NUNCA deduza isso sozinho.'
          }
        },
        required: ['titulo', 'data_hora'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agenda_deletar_evento',
      description: 'Remove um evento da agenda. Quando o usuário referenciar um evento por data/hora em vez de título (ex: "o evento de amanhã às 14h"), consulte a agenda primeiro com agenda_consultar para descobrir o título, depois delete pelo título encontrado.',
      parameters: {
        type: 'object',
        properties: {
          busca: {
            type: 'string',
            description: 'Título ou parte do título do evento. Se o usuário não informou o título, extraia-o da agenda antes de chamar esta tool.'
          },
        },
        required: ['busca'],
      },
    },
  },
];
