// lib/modules/modules/personalidade.ts
// V13.0.0 — Arquitetura V2 (Sinal de fumaça)

import type { ModuleDefinition } from '../types';

export const ModuloPersonalidade: ModuleDefinition = {
  id: 'personalidade',
  label: 'Personalidade',
  preferredModel: 'flash',
  plan: 'free',
  version: 'v2', // ← OFICIALMENTE V2
  
  trigger: {
    always: false,
    keywords: /humor|franqueza|formalidade|escuta|personalidade|tom|direto|leveza|relaxa|mais (sério|formal|informal|presente)/i,
    contexts: [],
  },
  
  // V2: Emite o sinal de fumaça para a IA saber que tem autonomia para alterar o tom ativamente.
  buildContextBlock: async () => {
    return `[Módulo: Personalidade] Ativo. O usuário deseja ajustar ou entender seu tom/comportamento. Use a tool 'personalidade_consultar' para verificar suas configurações atuais, ou 'personalidade_ajustar' para calibrar humor, formalidade e franqueza.`;
  },
  
  tools: [
    'personalidade_ajustar', 
    'personalidade_consultar'
  ],
  
  metrics: {
    avgTokens: 0,
    avgLatencyMs: 0,
    activationCount: 0,
  },
};
