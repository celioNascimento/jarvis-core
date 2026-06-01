// lib/tools/defs/esportes.ts

export const esportesTools = [
  {
    type: 'function',
    function: {
      name: 'esportes_consultar_placar_ao_vivo',
      description: 'Consulta jogos de futebol de uma liga específica — hoje, ontem ou em uma data. Use quando o usuário especificar o campeonato (brasileirão, champions, premier league, etc.).',
      parameters: {
        type: 'object',
        properties: {
          liga_tag: {
            type: 'string',
            enum: ['brasileirao_a', 'brasileirao_b', 'premier_league', 'champions_league', 'la_liga', 'serie_a_italiano'],
            description: 'Liga a consultar.',
          },
          quando: {
            type: 'string',
            description: 'Referência temporal: "hoje" (padrão), "ontem", "anteontem" ou uma data no formato YYYY-MM-DD.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'esportes_consultar_jogos_por_time',
      description: 'Busca jogos de um time específico pelo nome, sem precisar informar a liga. Use quando o usuário perguntar sobre um time específico (ex: "jogo do São Paulo ontem", "resultado do Flamengo").',
      parameters: {
        type: 'object',
        properties: {
          time: {
            type: 'string',
            description: 'Nome do time (ex: "São Paulo", "Flamengo", "Barcelona").',
          },
          quando: {
            type: 'string',
            description: 'Referência temporal: "hoje" (padrão), "ontem", "anteontem" ou uma data no formato YYYY-MM-DD.',
          },
        },
        required: ['time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'esportes_consultar_tabela',
      description: 'Consulta a tabela de classificação atualizada de um campeonato.',
      parameters: {
        type: 'object',
        properties: {
          liga_tag: {
            type: 'string',
            enum: ['brasileirao_a', 'brasileirao_b', 'premier_league', 'champions_league', 'la_liga', 'serie_a_italiano'],
            description: 'A liga que o usuário quer ver a tabela.',
          },
        },
        required: ['liga_tag'],
      },
    },
  },
];
