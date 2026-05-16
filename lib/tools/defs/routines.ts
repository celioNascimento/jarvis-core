// lib/tools/defs/routines.ts
// Definições de ferramentas: Rotinas e Hábitos

export const routinesTools = [
  {
    type: 'function',
    function: {
      name: 'listar_rotinas',
      description: 'Lista as rotinas ativas do usuário e mostra quais já foram concluídas ou puladas no dia de hoje.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gerenciar_rotina',
      description: 'Cria, atualiza ou remove uma rotina (hábito/tarefa recorrente).',
      parameters: {
        type: 'object',
        properties: {
          acao: {
            type: 'string',
            enum: ['criar', 'atualizar', 'remover'],
          },
          routine_id: {
            type: 'string',
            description: 'UUID da rotina. Obrigatório para atualizar ou remover. (Omita ao criar).',
          },
          anchor: {
            type: 'string',
            description: 'O gatilho da rotina (ex: "Ao acordar", "Depois do almoço").',
          },
          action: {
            type: 'string',
            description: 'A ação a ser feita (ex: "Beber 500ml de água", "Ler 10 páginas").',
          },
          period: {
            type: 'string',
            enum: ['morning', 'afternoon', 'evening', 'anytime'],
            description: 'Período do dia. Padrão: "anytime".',
          },
          goal_tag: {
            type: 'string',
            description: 'Tag do objetivo maior associado (ex: "saude", "leitura").',
          },
        },
        required: ['acao'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fazer_checkin_rotina',
      description: 'Marca uma rotina como feita (done), pulada (skipped) ou desmarca (reset) para o dia atual.',
      parameters: {
        type: 'object',
        properties: {
          rotina_texto: {
            type: 'string',
            description: 'Nome, âncora ou ação da rotina para o sistema buscar (ex: "beber água", "ler").',
          },
          status: {
            type: 'string',
            enum: ['done', 'skipped', 'reset'],
            description: 'Status do check-in. Use "reset" para desmarcar.',
          },
          note: {
            type: 'string',
            description: 'Nota opcional sobre como foi a execução.',
          },
        },
        required: ['rotina_texto', 'status'],
      },
    },
  },
];
