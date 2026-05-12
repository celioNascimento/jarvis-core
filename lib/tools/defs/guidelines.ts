// lib/tools/defs/guidelines.ts

export const guidelinesTools = [
  {
    type: 'function',
    function: {
      name: 'gerenciar_guideline',
      description: `Gerencia as diretrizes dinâmicas (System Prompts) do assistente.
Use isso quando o usuário pedir para você "lembrar de agir de tal forma", "mudar uma regra de comportamento" ou "editar seu system prompt".
Permite adicionar, listar, editar ou remover completamente as regras.`,
      parameters: {
        type: 'object',
        properties: {
          acao: {
            type: 'string',
            enum: ['adicionar', 'listar', 'editar', 'remover'],
            description: 'Ação a ser executada na base de diretrizes.',
          },
          id: {
            type: 'integer',
            description: 'ID numérico da guideline. Obrigatório para editar ou remover. Para obter o ID, faça um listar primeiro.',
          },
          content: {
            type: 'string',
            description: 'O texto exato da diretriz de comportamento ou instrução. Obrigatório para "adicionar".',
          },
          scope: {
            type: 'string',
            description: 'Contexto de uso da diretriz. Ex: "personal", "coding", "writing", "finance". Padrão é "personal".',
          },
          active: {
            type: 'boolean',
            description: 'Se a diretriz está ativada (true) ou pausada (false). Usado em "editar".',
          }
        },
        required: ['acao'],
      },
    },
  },
];
