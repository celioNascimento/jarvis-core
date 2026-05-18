// lib/tools/defs/personality.ts

export const personalityTools = [
  {
    type: 'function',
    function: {
      name: 'personalidade_ajustar',
    description: 'Ajusta um parâmetro de personalidade do Lev. Dispara quando o usuário mencionar qualquer ajuste de tom, humor, franqueza, escuta ou formalidade — com número, porcentagem ou expressão ("mais leveza", "seja mais direto"). Converta porcentagem para inteiro (70% = 70).',
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