// lib/tools/defs/dossie.ts

export const dossieTools = [
  {
    type: 'function',
    function: {
      name: 'dossie_atualizar',
      description: 'Atualiza uma seção do dossiê biográfico do usuário e reindexa automaticamente a memória L3. Use quando o usuário compartilhar informação relevante sobre si mesmo que deva ser lembrada permanentemente — comportamentos, preferências, saúde, rotina, família, projetos.',
      parameters: {
        type: 'object',
        properties: {
          tema: {
            type: 'string',
            enum: ['perfil', 'familia', 'rotina', 'projetos', 'saude', 'financas', 'preferencias', 'fe', 'objetivos', 'datas'],
            description: 'Seção do dossiê a ser atualizada.',
          },
          conteudo: {
            type: 'string',
            description: 'Conteúdo completo e atualizado da seção, em formato markdown com itens precedidos de "-".',
          },
        },
        required: ['tema', 'conteudo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dossie_consultar',
      description: 'Consulta o dossiê biográfico do usuário. Use quando precisar verificar informações específicas sobre o usuário antes de responder.',
      parameters: {
        type: 'object',
        properties: {
          tema: {
            type: 'string',
            enum: ['perfil', 'familia', 'rotina', 'projetos', 'saude', 'financas', 'preferencias', 'fe', 'objetivos', 'datas'],
            description: 'Seção específica a consultar. Se omitido, retorna o dossiê completo.',
          },
        },
      },
    },
  },
];
