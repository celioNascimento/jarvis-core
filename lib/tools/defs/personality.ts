// lib/tools/defs/personality.ts

export const personalityTools = [
  {
    type: 'function',
    function: {
      name: 'personalidade_ajustar',
      description: 'Ajusta um parâmetro de personalidade do Lev. Use quando o usuário pedir para mudar o tom, humor, franqueza ou modo de escuta — explicitamente ou por contexto ("seja mais direto", "pode relaxar um pouco", "quero que você ouça mais").',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            enum: ['humor', 'franqueza', 'formalidade', 'modo_escuta'],
            description: 'Parâmetro a ajustar.',
          },
          value: {
            type: 'integer',
            minimum: 0,
            maximum: 100,
            description: 'Novo valor entre 0 e 100.',
          },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'personalidade_consultar',
      description: 'Consulta os parâmetros de personalidade atuais do Lev.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];