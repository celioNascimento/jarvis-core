// lib/tools/defs/clima.ts
// Definições de ferramentas: Clima e Previsão do Tempo

export const climaTools = [
  {
    type: 'function',
    function: {
      name: 'clima_consultar_atual',
      description: 'Consulta o clima atual e a previsão dos próximos dias com base na localização GPS exata do usuário.',
      parameters: {
        type: 'object',
        properties: {}, // Não precisa de parâmetros, o backend resolve a localização automaticamente
      },
    },
  },
];
