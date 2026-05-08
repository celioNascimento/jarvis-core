// Definições de ferramentas: Lugares, Listas de Compras e Serviços Externos

export const lugaresTools = [
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
      description: 'Exibe a lista de compras de um lugar.',
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
        properties: {
          lat: { type: 'number' },
          lng: { type: 'number' },
        },
        required: ['lat', 'lng'],
      },
    },
  },
];