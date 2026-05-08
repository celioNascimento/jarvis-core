// lib/chat/tools-def.ts
// Definição estática das ferramentas expostas ao LLM via OpenRouter
// Versão Final: Sem duplicatas e com suporte a Dias Úteis (weekdays)

export const tools = [
  // ── MEMÓRIA E CONFIGURAÇÃO ────────────────────────────────────────────────
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
      name: 'adicionar_diretriz_dinamica',
      description: "AÇÃO OBRIGATÓRIA: Use sempre que o usuário pedir para mudar seu comportamento ou criar uma nova regra (ex: 'nunca mais faça X', 'aja assim').",
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'O texto claro da nova regra.' },
          scope: { type: 'string', enum: ['personal', 'global'], default: 'personal' },
        },
        required: ['content'],
      },
    },
  },

  // ── AGENDA LEV (PROPRIEDADE JARVIS) ───────────────────────────────────────
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

  // ── MOTOR DE LEMBRETES ────────────────────────────────────────────────────
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

  // ── INTEGRAÇÕES EXTERNAS (GOOGLE/OUTLOOK/WEB) ──────────────────────────────
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
  {
    type: 'function',
    function: {
      name: 'listar_emails_recentes',
      description: 'Busca emails recentes via Microsoft/Google.',
      parameters: {
        type: 'object',
        properties: {
          filtro: { type: 'string', description: 'Termo para filtrar emails' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchWeb',
      description: 'Pesquisa na internet em tempo real (notícias, fatos de 2026).',
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
      description: 'Obtém previsão do tempo para os próximos 5 dias.',
      parameters: {
        type: 'object',
        properties: { lat: { type: 'number' }, lng: { type: 'number' } },
        required: ['lat', 'lng'],
      },
    },
  },

  // ── LUGARES E LISTAS ──────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'salvar_lugar',
      description: 'Salva um lugar favorito com coordenadas e raio de alerta.',
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
      description: 'Adiciona item à lista de compras de um lugar.',
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
      description: 'Exibe a lista de compras de um lugar.',
      parameters: {
        type: 'object',
        properties: { lugar: { type: 'string' } },
        required: ['lugar'],
      },
    },
  },

  // ── FINANÇAS ──────────────────────────────────────────────────────────────
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
      description: 'Consulta resumo financeiro por período.',
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
      description: 'Exibe limites de gastos por categoria.',
      parameters: { type: 'object', properties: {} }
    }
  },

  // ── VEÍCULOS (EXPERTFROTAS) ───────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'registrar_abastecimento',
      description: 'Registra abastecimento de combustível.',
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
      description: 'Atualiza a quilometragem atual do veículo.',
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

  // ── FOCO, TDAH E DIÁRIO ───────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'gerenciar_eisenhower',
      description: 'Adiciona ou completa itens na Matriz de Eisenhower.',
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
  {
    type: 'function',
    function: {
      name: 'quebrar_tarefa',
      description: "Decompõe tarefa complexa em micro-passos.",
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
  {
    type: 'function',
    function: {
      name: 'registrar_no_diario',
      description: 'Adiciona uma entrada no diário pessoal.',
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
      name: 'atualizar_meta',
      description: 'Atualiza o progresso de uma meta existente.',
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
];
