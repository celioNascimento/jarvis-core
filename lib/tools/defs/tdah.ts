// Definições de ferramentas: Foco, TDAH, Diário e Metas

export const tdahTools = [
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
          quadrante: { type: 'string', enum: ['q1', 'q2', 'q3', 'q4'] },
        },
        required: ['acao', 'texto'],
      },
    },
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
      description: 'Decompõe tarefa complexa em micro-passos.',
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