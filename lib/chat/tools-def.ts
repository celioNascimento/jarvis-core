// lib/chat/tools-def.ts
// Definição estática das ferramentas expostas ao LLM via OpenRouter

export const tools = [
  {
    type: 'function',
    function: {
      name: 'buscar_memoria_longa',
      description: 'Busca memórias de longo prazo (L3 e HD) relevantes para o contexto atual',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termo ou pergunta para busca semântica' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_agenda',
      description: 'Obtém eventos do Google Calendar e Outlook para os próximos dias',
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
      name: 'listar_emails_recentes',
      description: 'Busca emails recentes, opcionalmente por filtro',
      parameters: {
        type: 'object',
        properties: {
          filtro: { type: 'string', description: 'Termo para filtrar emails (opcional)' },
        },
      },
    },
  },

  // ── AGENDA PRÓPRIA (jarvis) ────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'salvar_evento',
      description:
        'Salva um compromisso na AGENDA PRÓPRIA (jarvis.agenda). Use para consultas, reuniões, aulas, aniversários.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          event_date: { type: 'string', description: 'ISO: YYYY-MM-DDTHH:mm:00' },
          category: { type: 'string' },
          notes: { type: 'string' },
          is_recurring: { type: 'boolean' },
        },
        required: ['title', 'event_date'],
      },
    },
  },

  // ── GOOGLE CALENDAR ────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'criar_evento_agenda',
      description: 'Cria evento NO GOOGLE CALENDAR (somente se solicitado explicitamente).',
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

  {
    type: 'function',
    function: {
      name: 'atualizar_meta',
      description: 'Atualiza o progresso de uma meta existente',
      parameters: {
        type: 'object',
        properties: {
          titulo_parcial: { type: 'string' },
          progresso: { type: 'integer', minimum: 0, maximum: 100 },
          etapa_concluida: { type: 'string' },
        },
        required: ['titulo_parcial', 'progresso'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'registrar_no_diario',
      description: 'Adiciona uma entrada no diário pessoal',
      parameters: {
        type: 'object',
        properties: {
          texto: { type: 'string' },
          categoria: { type: 'string', enum: ['reflexao', 'acontecimento', 'gratidao', 'qualquer'] },
        },
        required: ['texto'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'searchWeb',
      description: 'Pesquisa na internet em tempo real (notícias, fatos de 2026, etc).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'getWeatherForecast',
      description: 'Obtém clima preciso para 5 dias.',
      parameters: {
        type: 'object',
        properties: { lat: { type: 'number' }, lng: { type: 'number' } },
        required: ['lat', 'lng'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'salvar_lugar',
      description: 'Salva um lugar favorito com coordenadas e raio de alerta',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          lat: { type: 'number' },
          lng: { type: 'number' },
          raio_metros: { type: 'integer' },
          categoria: { type: 'string' },
        },
        required: ['nome', 'lat', 'lng', 'raio_metros', 'categoria'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'adicionar_item_lista',
      description: 'Adiciona um item à lista de compras de um lugar',
      parameters: {
        type: 'object',
        properties: { item: { type: 'string' }, lugar: { type: 'string' } },
        required: ['item', 'lugar'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'ver_lista',
      description: 'Exibe a lista de compras de um lugar',
      parameters: {
        type: 'object',
        properties: { lugar: { type: 'string' } },
        required: ['lugar'],
      },
    },
  },

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
          frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
          location_trigger: { type: 'string' },
        },
        required: ['title', 'type'],
      },
    },
  },

   {
    type: 'function',
    function: {
      name: 'adicionar_diretriz_dinamica',
      description: "AÇÃO OBRIGATÓRIA E IMEDIATA: Execute esta ferramenta SEMPRE que o usuário pedir para você mudar de comportamento, alterar seu tom de voz, criar uma nova regra de convivência ou usar frases como 'nunca mais faça X', 'aja assim', 'lembre-se de agir'. É ESTRITAMENTE PROIBIDO confirmar a mudança no texto sem antes invocar esta ferramenta.",
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'O texto claro e direto da nova regra.' },
          scope: { type: 'string', enum: ['personal', 'global'], default: 'personal' },
        },
        required: ['content'],
      },
    },
  },
  

  {
    type: 'function',
    function: {
      name: 'quebrar_tarefa',
      description: "Decompõe tarefa complexa em micro-passos (Módulo TDAH).",
      parameters: {
        type: 'object',
        properties: {
          tarefa_principal: { type: 'string' },
          estado_cognitivo: { type: 'string', enum: ['sobrecarregado', 'sem_energia', 'neutro'] },
        },
        required: ['tarefa_principal', 'estado_cognitivo'],
      },
    },
  },

  // ── FINANÇAS ──────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'registrar_transacao',
      description: 'Registra despesa, receita ou transferência.',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          type: { type: 'string', enum: ['expense', 'income', 'transfer_out', 'transfer_in'] },
          description: { type: 'string' },
          category_name: { type: 'string' },
          merchant: { type: 'string' },
          account_label: { type: 'string' }
        },
        required: ['amount', 'type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'consultar_financas',
      description: 'Consulta resumo financeiro ou transações recentes do período.',
      parameters: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['today', 'week', 'month', 'last_month', 'year'] }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listar_orcamentos',
      description: 'Exibe os limites de gastos por categoria e quanto já foi usado.',
      parameters: { type: 'object', properties: {} }
    }
  },

  // ── VEÍCULOS (ExpertFrotas) ────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'registrar_abastecimento',
      description: 'Registra abastecimento de combustível e atualiza o odômetro.',
      parameters: {
        type: 'object',
        properties: {
          vehicle_name: { type: 'string' },
          fuel_type: { type: 'string', enum: ['gasoline', 'ethanol', 'diesel', 'gnv', 'electric'] },
          total_cost: { type: 'number' },
          odometer: { type: 'integer' },
          liters: { type: 'number' }
        },
        required: ['vehicle_name', 'fuel_type', 'total_cost', 'odometer']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'atualizar_odometro',
      description: 'Atualiza apenas a quilometragem atual do veículo.',
      parameters: {
        type: 'object',
        properties: {
          vehicle_name: { type: 'string' },
          odometer: { type: 'integer' }
        },
        required: ['vehicle_name', 'odometer']
      }
    }
  },

  // ── FOCO E TDAH ───────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'gerenciar_eisenhower',
      description: 'Adiciona, completa ou move itens na Matriz de Eisenhower.',
      parameters: {
        type: 'object',
        properties: {
          acao: { type: 'string', enum: ['adicionar', 'completar', 'mover'] },
          texto: { type: 'string' },
          quadrante: { type: 'string', enum: ['q1', 'q2', 'q3', 'q4'] }
        },
        required: ['acao', 'texto']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'criar_rotina',
      description: 'Cria uma nova rotina (gatilho + ação). Vital para TDAH.',
      parameters: {
        type: 'object',
        properties: {
          anchor: { type: 'string', description: 'Gatilho (ex: Ao acordar)' },
          action: { type: 'string', description: 'Ação (ex: Beber água)' },
          period: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'anytime'] },
        },
        required: ['anchor', 'action', 'period'],
      },
    },
  },
];
