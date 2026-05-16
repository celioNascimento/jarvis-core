// lib/tools/defs/tdah.ts
// Definições de ferramentas: Foco e TDAH

export const tdahTools = [
  {
    type: 'function',
    function: {
      name: 'tdah_gerenciar_eisenhower',
      description: 'Cria, lista, atualiza ou remove tarefas na Matriz de Eisenhower.',
      parameters: {
        type: 'object',
        properties: {
          acao: {
            type: 'string',
            enum: ['listar', 'criar', 'atualizar', 'remover'],
          },
          item_id: {
            type: 'string',
            description: 'UUID do item. Obrigatório para atualizar e remover.',
          },
          text: {
            type: 'string',
            description: 'A tarefa em si.',
          },
          quadrant: {
            type: 'string',
            enum: ['q1', 'q2', 'q3', 'q4'],
            description: 'Q1: Urgente/Importante, Q2: Não Urg/Imp, Q3: Urg/Não Imp, Q4: Não Urg/Não Imp.',
          },
          completed: {
            type: 'boolean',
            description: 'Status da tarefa.',
          },
        },
        required: ['acao'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tdah_quebrar_tarefa',
      description: 'Salva uma quebra de tarefa no banco de dados para auxiliar na redução de atrito (TDAH).',
      parameters: {
        type: 'object',
        properties: {
          original_task: { type: 'string' },
          spice_level: { type: 'integer', description: 'Nível de "tempero/dificuldade" percebido (1 a 5).' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Os passos menores da tarefa.',
          },
          used_in_focus: { type: 'boolean' },
        },
        required: ['original_task', 'steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tdah_registrar_despejo_mental',
      description: 'Salva um pensamento, preocupação ou ideia solta como "Brain Dump" para limpar a mente do usuário.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'O texto do despejo mental.' },
          category: { type: 'string', description: 'Ex: "trabalho", "pessoal", "ideia", "ansiedade".' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tdah_registrar_sessao_foco',
      description: 'Salva os resultados de uma sessão de foco ou Pomodoro recém finalizada.',
      parameters: {
        type: 'object',
        properties: {
          task_original: { type: 'string', description: 'A tarefa que o usuário tentou focar.' },
          steps_completed: { type: 'integer', description: 'Quantos passos concluiu.' },
          steps_total: { type: 'integer', description: 'Total de passos planejados.' },
          cancelled: { type: 'boolean', description: 'Verdadeiro se a sessão foi interrompida antes do fim.' },
          reward_chosen: { type: 'string', description: 'A recompensa escolhida.' },
          halt_triggered: { type: 'boolean', description: 'Verdadeiro se o usuário acionou protocolo HALT.' },
        },
        required: ['task_original'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tdah_consultar_resumo',
      description: 'Consulta o resumo executivo dos últimos 7 dias de foco, tarefas pendentes na matriz e despejos mentais.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];
