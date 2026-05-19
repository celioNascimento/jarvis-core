// lib/tools/defs/projects.ts
// Definições de ferramentas: Projetos, Tópicos, Entries e Membros
// V4 — descrições reforçadas para evitar que o modelo recuse ações possíveis

export const projectsTools = [
  // ── Projetos ──────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'gerenciar_projeto',
      description: `SEMPRE use esta tool para criar, atualizar ou mudar o status de um projeto.
Fluxo de status:
  criar       → em_desenvolvimento
  arquivar    → em_pausa          (reversível, itens de compra permanecem ativos)
  reativar    → em_desenvolvimento (a partir de em_pausa)
  concluir    → concluido         (arquiva itens de compra vinculados automaticamente)
  cancelar    → cancelado         (arquiva itens de compra vinculados automaticamente)
  atualizar   → altera nome, descrição, URLs sem mudar status

Exemplos de trigger: "cria um projeto para a reforma", "pausa o projeto Lev", "marca o ExpertFrotas como concluído".`,
      parameters: {
        type: 'object',
        properties: {
          acao: {
            type: 'string',
            enum: ['criar', 'atualizar', 'arquivar', 'reativar', 'concluir', 'cancelar'],
            description: 'Operação a realizar.',
          },
          project_id: {
            type: 'string',
            description:
              'UUID, Nome ou Tag do projeto (ex: "Lev" ou "ExpertFrotas"). Se não souber o UUID, envie apenas o nome. Obrigatório para todas as ações exceto criar.',
          },
          tag: {
            type: 'string',
            description: 'Identificador curto e único (ex: "reforma-casa", "app-financas"). Obrigatório para criar.',
          },
          name: { type: 'string', description: 'Nome legível do projeto.' },
          description: { type: 'string', description: 'Resumo curto / tagline do projeto.' },
          status: {
            type: 'string',
            enum: ['em_desenvolvimento', 'em_pausa', 'concluido', 'cancelado'],
            description: 'Usado apenas com acao "atualizar" para forçar um status específico.',
          },
          url: { type: 'string', description: 'URL pública do projeto.' },
          repo_url: { type: 'string', description: 'URL do repositório de código.' },
          cover_url: { type: 'string', description: 'URL da imagem de capa.' },
        },
        required: ['acao'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'listar_projetos',
      description:
        'SEMPRE use esta tool quando o usuário pedir para ver, listar ou consultar seus projetos. Filtre por status se o usuário especificar (ex: "projetos ativos", "projetos pausados").',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['em_desenvolvimento', 'em_pausa', 'concluido', 'cancelado'],
            description: 'Filtra por status. Omitir retorna todos.',
          },
        },
      },
    },
  },

  // ── Tópicos ───────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'gerenciar_topico',
      description:
        'SEMPRE use para criar, atualizar ou remover um tópico dentro de um projeto. Tópicos são hierárquicos via parent_id — um tópico pode ter subtópicos. Remover um tópico remove em cascata todos os subtópicos e entries vinculados.',
      parameters: {
        type: 'object',
        properties: {
          acao: {
            type: 'string',
            enum: ['criar', 'atualizar', 'remover'],
          },
          project_id: {
            type: 'string',
            description:
              'UUID, Nome ou Tag do projeto pai (ex: "Lev" ou "ExpertFrotas"). Sempre obrigatório.',
          },
          topic_id: {
            type: 'string',
            description: 'UUID do tópico. Obrigatório para atualizar/remover.',
          },
          parent_id: {
            type: 'string',
            description: 'UUID do tópico pai. Omitir cria o tópico na raiz do projeto.',
          },
          tag: {
            type: 'string',
            description: 'Identificador curto único dentro do mesmo nível. Obrigatório para criar.',
          },
          name: { type: 'string', description: 'Nome legível do tópico.' },
          description: { type: 'string', description: 'Contexto ou descrição breve.' },
          order_index: { type: 'integer', description: 'Posição na ordem de exibição.' },
        },
        required: ['acao', 'project_id'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'listar_topicos',
      description:
        'Lista os tópicos de um projeto. Passe parent_id para ver subtópicos de um nível específico, ou omita para ver todos.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'UUID, Nome ou Tag do projeto.',
          },
          parent_id: {
            type: 'string',
            description: 'UUID do tópico pai. Passe null para ver apenas a raiz.',
          },
        },
        required: ['project_id'],
      },
    },
  },


// ── Entries (Cards do Kanban) ─────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'gerenciar_entry',
      description:
        'Registra, atualiza ou remove uma entry (tarefa/card) de um projeto. Use esta ferramenta para mover cards no Kanban alterando o seu "status".',
      parameters: {
        type: 'object',
        properties: {
          acao: {
            type: 'string',
            enum: ['criar', 'atualizar', 'remover'],
          },
          project_id: {
            type: 'string',
            description: 'UUID, Nome ou Tag do projeto.',
          },
          topic_id: {
            type: 'string',
            description: 'UUID do tópico (se a tarefa pertencer a um subtópico específico).',
          },
          entry_id: {
            type: 'string',
            description: 'UUID da entry. Obrigatório para atualizar/remover.',
          },
          type: {
            type: 'string',
            description: 'Categoria da tarefa (ex: "task", "note", "bug"). Padrão: "task".',
          },
          title: { type: 'string', description: 'Título do card no Kanban.' },
          body: { type: 'string', description: 'Conteúdo ou checklist interno.' },
          status: {
            type: 'string',
            description: 'A COLUNA DO KANBAN onde o card está (ex: "A Fazer", "Fazendo", "Feito", "Pausado").',
          },
          order_index: { type: 'integer' },
        },
        required: ['acao', 'project_id'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'listar_entries',
      description: 'Lista as tarefas/cards de um projeto ou tópico, organizadas por coluna do Kanban.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'UUID, Nome ou Tag do projeto.',
          },
          status: {
            type: 'string',
            description: 'Filtra por uma coluna específica (ex: "Fazendo"). Omitir retorna o quadro inteiro.',
          },
        },
        required: ['project_id'],
      },
    },
  },

  // ── Membros do Projeto ────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'gerenciar_membros_projeto',
      description: `SEMPRE use esta tool quando o usuário pedir para:
- Compartilhar um projeto com alguém ("compartilha o projeto X com a Gih")
- Convidar alguém para um projeto ("adiciona a Ana como editora do Lev")
- Ver quem tem acesso a um projeto ("quem pode ver o projeto reforma?")
- Remover alguém de um projeto ("tira a Gih do projeto X")
- Alterar o papel de um membro ("muda a Gih para editora")

NUNCA diga que não consegue compartilhar projetos. Use esta tool.

Ações disponíveis:
  adicionar  → envia convite (status "pending") com o papel escolhido
  remover    → revoga o acesso do usuário
  atualizar  → muda o papel (owner / editor / viewer)
  listar     → mostra todos os membros e seus papéis`,
      parameters: {
        type: 'object',
        properties: {
          acao: {
            type: 'string',
            enum: ['adicionar', 'remover', 'atualizar', 'listar'],
            description: 'Ação a ser executada.',
          },
          project_id: {
            type: 'string',
            description:
              'Nome, Tag ou UUID do projeto (ex: "reforma banheiro"). Envie apenas o nome se não souber o UUID.',
          },
          user_identifier: {
            type: 'string',
            description:
              'Nome ou email da pessoa. Obrigatório para adicionar, remover e atualizar. Não é necessário para listar.',
          },
          role: {
            type: 'string',
            enum: ['owner', 'editor', 'viewer'],
            description: 'Nível de permissão. Padrão: "viewer". Usado ao adicionar ou atualizar.',
          },
        },
        required: ['acao', 'project_id'],
      },
    },
  },
];
