// lib/tools/defs/projects.ts
// Definições de ferramentas: Projetos, Tópicos e Entries
// V2 — ações reativar, concluir e cancelar adicionadas

export const projectsTools = [
  // ── Projetos ──────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'gerenciar_projeto',
      description: `Gerencia o ciclo de vida completo de um projeto.
Fluxo de status:
  criar       → em_desenvolvimento
  arquivar    → em_pausa          (reversível, itens de compra permanecem)
  reativar    → em_desenvolvimento (a partir de em_pausa)
  concluir    → concluido         (arquiva itens de compra vinculados automaticamente)
  cancelar    → cancelado         (arquiva itens de compra vinculados automaticamente)
  atualizar   → altera nome, descrição, URLs sem mudar status

Use listar_projetos antes de operar por nome para obter o UUID.`,
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
            description: 'UUID do projeto. Obrigatório para todas as ações exceto criar.',
          },
          tag: {
            type: 'string',
            description: 'Identificador curto e único (ex: "reforma-casa", "app-financas"). Obrigatório para criar.',
          },
          name:        { type: 'string', description: 'Nome legível do projeto.' },
          description: { type: 'string', description: 'Resumo curto / tagline do projeto.' },
          status: {
            type: 'string',
            enum: ['em_desenvolvimento', 'em_pausa', 'concluido', 'cancelado'],
            description: 'Usado apenas com acao "atualizar" para forçar um status específico.',
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
        'Lista todos os projetos do usuário. Use antes de operar em um projeto pelo nome para obter o UUID. Filtre por status se necessário.',
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
        'Cria, atualiza ou remove um tópico dentro de um projeto. Tópicos são hierárquicos via parent_id. Remover um tópico remove em cascata todos os subtópicos e entries vinculados.',
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
            description: 'Identificador curto único dentro do mesmo nível. Obrigatório para criar.',
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
          project_id: { type: 'string', description: 'UUID do projeto.' },
          parent_id: {
            type: 'string',
            description: 'UUID do tópico pai. Passe null para ver apenas a raiz.',
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
        'Registra, atualiza ou remove uma entry dentro de um tópico. O campo type é livre: "idea", "note", "tech_debt", "decision", "block", "link", "opcao", "referencia", etc.',
      parameters: {
        type: 'object',
        properties: {
          acao: {
            type: 'string',
            enum: ['criar', 'atualizar', 'remover'],
          },
          project_id: {
            type: 'string',
            description: 'UUID do projeto (para verificar acesso).',
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
            description: 'Categoria livre. Padrão: "note".',
          },
          title:       { type: 'string', description: 'Título curto da entry.' },
          body:        { type: 'string', description: 'Conteúdo completo.' },
          status: {
            type: 'string',
            enum: ['open', 'em_analise', 'aprovado', 'descartado', 'concluido'],
            description: 'Status da entry. Padrão: "open".',
          },
          order_index: { type: 'integer' },
          metadata: {
            type: 'object',
            description: 'Dados extras livres (ex: { "url": "...", "custo_estimado": 1200 }).',
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
      description: 'Lista as entries de um tópico. Filtre por type ou status conforme necessário.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'UUID do projeto.' },
          topic_id:   { type: 'string', description: 'UUID do tópico.' },
          type: {
            type: 'string',
            description: 'Filtra pelo tipo. Omitir retorna todos.',
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
