// Definições de ferramentas: Memória e Configuração

export const memoryTools = [
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
];