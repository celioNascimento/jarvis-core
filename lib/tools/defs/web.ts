// lib/tools/defs/web.ts
// Definição de ferramenta: Pesquisa Web em tempo real

export const webTools = [
  {
    type: 'function',
    function: {
      name: 'web_pesquisar',
      description: `Pesquisa informações atuais na internet.
Use OBRIGATORIAMENTE esta tool antes de responder sobre:
- Jogos, placares, resultados e finais de competições esportivas
- Notícias, eventos e acontecimentos recentes
- Preços, cotações, câmbio e mercado financeiro
- Clima e previsão do tempo (quando o módulo de clima não estiver disponível)
- Qualquer fato que dependa da data de hoje ou que possa ter mudado após o treinamento do modelo

NUNCA responda sobre esses tópicos sem chamar esta tool primeiro.
O modelo não sabe o que aconteceu depois do seu corte de treinamento — inventar é proibido.`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Consulta de busca em linguagem natural. Seja específico: inclua nomes, datas e contexto. Ex: "final Champions League 2026 times", "cotação dólar hoje".',
          },
        },
        required: ['query'],
      },
    },
  },
];
