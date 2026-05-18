// lib/tools/defs/personality.ts

export const personalityTools = [
  {
    type: 'function',
    function: {
      name: 'personalidade_ajustar',
    description: 'SEMPRE chame esta tool quando o usuário pedir para ajustar humor, franqueza, formalidade ou modo de escuta — com número, porcentagem ou expressão ("mais leveza", "seja mais direto", "pode relaxar"). Converta porcentagem para inteiro (70% = 70). Execute imediatamente, sem confirmar.',
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