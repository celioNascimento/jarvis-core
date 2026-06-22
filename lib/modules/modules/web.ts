// lib/modules/modules/web.ts
// V13.0.0 — Arquitetura V2 (Sinal de fumaça): Redução do payload de diretiva transversal

import type { ModuleDefinition } from '../types';

export const ModuloWeb: ModuleDefinition = {
  id: 'web',
  label: 'Pesquisa Web em Tempo Real',
  preferredModel: 'flash',
  plan: 'free',
  version: 'v2', // ← OFICIALMENTE V2
  trigger: {
    always: true, // Sempre ativo — web search é transversal a todos os contextos
  },

  buildContextBlock: async () => {
    // V2: Condensação da regra rígida. Mantém a proibição de alucinação e força o uso da tool, 
    // mas corta as listas de exemplos e o texto redundante.
    return `[Módulo: Web] Ativo. É OBRIGATÓRIO usar a tool 'web_pesquisar' para fatos atuais, esportes de hoje, notícias, cotações ou preços. JAMAIS invente dados temporais ou responda sobre o tempo real usando seu treinamento base; se a busca falhar, diga que não encontrou.`;
  },

  tools: ['web_pesquisar'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 },
};
