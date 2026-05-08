// lib/tools/definitions/projects.ts
// Definições de ferramentas: Projetos, Tópicos e Entries

export const projectsTools = [
  // ── Projetos ──────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'gerenciar_projeto',
      description:
        'Cria, atualiza ou arquiva um projeto. Use "criar" quando o usuário mencionar um novo projeto ou iniciativa. Use "atualizar" para mudar nome, status ou descrição. Use "arquivar" para encerrar.',
      parameters: {
        type: 'object',
        properties: {
          acao: {
            type: 'string',
            enum: ['criar', 'atualizar', 'arquivar'],
            description: 'Operação a realizar.',
          },
          project_id: {
            type: 'string',
            description: 'UUID do projeto. Obrigatório para atualizar/arquivar.',
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
          },
          url:       { type: 'string', description: 'URL pública do projeto.' },
          repo_url:  { type: 'string', description: 'URL do repositório de código.' },
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
        'Lista todos os projetos do usuário (incluindo projetos compartilhados). Útil quando o usuário pede para ver seus projetos ou antes de operar em um projeto pelo nome.',
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
        'Cria, atualiza ou remove um tópico/módulo dentro de um projeto. Tópicos são hierárquicos: um tópico pode ter subtópicos via parent_id. Exemplos: "banheiro" dentro de "reforma-casa", ou "piso" dentro de "banheiro".',
      parameters: {
        type: 'object',
        properties: {
          acao: {
            type: 'string',
            enum: ['criar', 'atualizar', 'remover'],
          },
          project_id: {
            type: 'string',
            description: 'UUID do projeto pai. Sempre obrigatório.',
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
            description: 'Identificador curto único dentro do mesmo nível (ex: "banheiro", "piso"). Obrigatório para criar.',
          },
          name:        { type: 'string', description: 'Nome legível do tópico.' },
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
            description: 'UUID do projeto.',
          },
          parent_id: {
            type: 'string',
            description: 'UUID do tópico pai para filtrar subtópicos. Passe null para ver apenas a raiz.',
          },
        },
        required: ['project_id'],
      },
    },
  },

  // ── Entries ───────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'gerenciar_entry',
      description:
        'Registra, atualiza ou remove uma entry dentro de um tópico. Uma entry pode ser qualquer anotação contextual: ideia, dívida técnica, decisão, bloqueio, link, nota, etc. O campo "type" é texto livre — use o termo que melhor descreve o contexto (ex: "idea", "tech_debt", "decision", "block", "note", "link", "opcao").',
      parameters: {
        type: 'object',
        properties: {
          acao: {
            type: 'string',
            enum: ['criar', 'atualizar', 'remover'],
          },
          project_id: {
            type: 'string',
            description: 'UUID do projeto (necessário para verificar acesso).',
          },
          topic_id: {
            type: 'string',
            description: 'UUID do tópico onde a entry será registrada.',
          },
          entry_id: {
            type: 'string',
            description: 'UUID da entry. Obrigatório para atualizar/remover.',
          },
          type: {
            type: 'string',
            description:
              'Categoria livre da entry. Exemplos: "idea", "note", "tech_debt", "decision", "block", "link", "opcao", "referencia". Padrão: "note".',
          },
          title: { type: 'string', description: 'Título curto da entry.' },
          body:  { type: 'string', description: 'Conteúdo completo, observação ou detalhe.' },
          status: {
            type: 'string',
            enum: ['open', 'em_analise', 'aprovado', 'descartado', 'concluido'],
            description: 'Status da entry. Padrão: "open".',
          },
          order_index: { type: 'integer' },
          metadata: {
            type: 'object',
            description: 'Dados extras livres por tipo (ex: { "url": "...", "custo_estimado": 1200 }).',
          },
        },
        required: ['acao', 'project_id', 'topic_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_entries',
      description:
        'Lista as entries de um tópico. Filtre por type ou status conforme necessário.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'UUID do projeto.' },
          topic_id:   { type: 'string', description: 'UUID do tópico.' },
          type: {
            type: 'string',
            description: 'Filtra pelo tipo (ex: "idea", "tech_debt"). Omitir retorna todos.',
          },
          status: {
            type: 'string',
            enum: ['open', 'em_analise', 'aprovado', 'descartado', 'concluido'],
            description: 'Filtra pelo status. Omitir retorna todos.',
          },
        },
        required: ['project_id', 'topic_id'],
      },
    },
  },
];