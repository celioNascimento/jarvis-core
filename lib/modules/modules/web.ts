// lib/modules/modules/web.ts
// Módulo sempre ativo — injeta instrução de uso da web_pesquisar no system prompt

import type { ModuleDefinition } from '../types';

export const ModuloWeb: ModuleDefinition = {
  id: 'web',
  label: 'Pesquisa Web em Tempo Real',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    always: true, // Sempre ativo — web search é transversal a todos os contextos
  },

  buildContextBlock: async () => {
    return `[MÓDULO WEB — PESQUISA EM TEMPO REAL]
Você tem acesso à ferramenta web_pesquisar para buscar informações atuais na internet.

USE OBRIGATORIAMENTE web_pesquisar antes de responder sobre:
- Jogos, placares, resultados e finais esportivas de hoje
- Notícias e eventos recentes
- Preços, cotações e câmbio
- Qualquer fato que dependa da data atual ou que possa ter mudado após seu treinamento

NUNCA responda sobre esses tópicos com base no treinamento — os dados estão desatualizados.
Se a busca não retornar resultado, diga que não encontrou — jamais invente.`;
  },

  tools: ['web_pesquisar'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 },
};
