// lib/tools/defs/esportes.ts
// Definições de ferramentas: Placar e Classificação Esportiva

export const esportesTools = [
  {
    type: 'function',
    function: {
      name: 'esportes_consultar_placar_ao_vivo',
      description: 'Consulta jogos de futebol acontecendo em tempo real (placar ao vivo, minutos, gols).',
      parameters: {
        type: 'object',
        properties: {
          liga_tag: {
            type: 'string',
            enum: ['brasileirao_a', 'brasileirao_b', 'premier_league', 'champions_league', 'la_liga', 'serie_a_italiano'],
            description: 'Filtro opcional por liga específica.'
          }
        }
      }
    }
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
            description: 'A liga que o usuário quer ver a tabela (Obrigatório).'
          }
        },
        required: ['liga_tag']
      }
    }
  }
];
