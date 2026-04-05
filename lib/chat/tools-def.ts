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
  {
    type: 'function',
    function: {
      name: 'salvar_evento',
      description: 'Registra um evento (compromisso, aniversário, etc.) no banco de dados',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string' },
          data: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
          prioridade: { type: 'string', enum: ['alta', 'media', 'baixa'] },
          recorrente: { type: 'boolean', description: 'true para aniversários e eventos anuais' },
          tipo: { type: 'string', enum: ['permanent', 'recurring_annual', 'deadline', 'one_time'] },
        },
        required: ['titulo', 'data', 'prioridade', 'recorrente', 'tipo'],
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
          titulo_parcial: { type: 'string', description: 'Parte do título da meta' },
          progresso: { type: 'integer', minimum: 0, maximum: 100 },
          etapa_concluida: { type: 'string', description: 'Nome da etapa concluída (opcional)' },
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
      description:
        'Pesquisa na internet em tempo real. Use para notícias, resultados de jogos, fatos de 2026 e informações que não estão na sua memória.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'O termo de busca preciso' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getWeatherForecast',
      description:
        'Obtém clima preciso para 5 dias. Use coordenadas de Londrina (-23.27, -51.20) para o Vista Bela se o usuário não der outras.',
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number' },
          lng: { type: 'number' },
        },
        required: ['lat', 'lng'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'salvar_lugar',
      description: 'Salva um lugar favorito (mercado, farmácia, etc.) com coordenadas e raio de alerta',
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
      name: 'remover_lugar',
      description: 'Remove um lugar favorito pelo nome',
      parameters: {
        type: 'object',
        properties: { nome: { type: 'string' } },
        required: ['nome'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adicionar_item_lista',
      description: 'Adiciona um item à lista de compras de um lugar específico',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          lugar: { type: 'string' },
        },
        required: ['item', 'lugar'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'marcar_feito',
      description: 'Marca um item da lista como comprado',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          lugar: { type: 'string' },
        },
        required: ['item', 'lugar'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remover_item_lista',
      description: 'Remove um item da lista de compras',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          lugar: { type: 'string' },
        },
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
  // 🔧 NOVA FERRAMENTA DE INSIGHT DE CLIMA
  {
    type: 'function',
    function: {
      name: 'get_weather_insights',
      description: 'Obtém uma dica personalizada sobre o clima atual e previsão para o usuário',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // Adicione este objeto ao array `tools` existente

{
  type: "function",
  function: {
    name: "create_reminder",
    description: "Cria um lembrete para o usuário. Use quando ele pedir 'me lembra', 'avisa', 'lembrar', 'não esquecer' com tempo ou local.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Título curto do lembrete (ex: 'Desligar feijão', 'Ligar para João')"
        },
        type: {
          type: "string",
          enum: ["temporary", "agenda", "recurring", "location"],
          description: "temporary = daqui a X minutos; agenda = data/hora fixa; recurring = repetição; location = geofencing"
        },
        delay_minutes: {
          type: "integer",
          description: "Obrigatório se type = temporary. Número de minutos a partir de agora."
        },
        scheduled_time: {
          type: "string",
          description: "Obrigatório se type = agenda. Data/hora no formato ISO com timezone, ex: '2026-04-10T17:00:00-03:00'"
        },
        frequency: {
          type: "string",
          enum: ["daily", "weekly", "monthly"],
          description: "Obrigatório se type = recurring."
        },
        location_trigger: {
          type: "string",
          description: "Obrigatório se type = location. Nome do local (deve estar em favorite_places). Ex: 'casa', 'mercado', 'escritório'"
        }
      },
      required: ["title", "type"]
    }
  }
}
];