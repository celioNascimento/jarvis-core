// lib/modules/modules/personalidade.ts
// V12.3.0 — Padrão mantido: Zero DB Calls Nativo (Orientado a Ferramentas)

import type { ModuleDefinition } from '../types';

export const ModuloPersonalidade: ModuleDefinition = {
  id: 'personalidade',
  label: 'Personalidade',
  preferredModel: 'flash',
  plan: 'free',
  
  trigger: {
    always: false,
    keywords: /humor|franqueza|formalidade|escuta|personalidade|tom|direto|leveza|relaxa|mais (sério|formal|informal|presente)/i,
    contexts: [],
  },
  
  // O módulo não precisa injetar contexto, pois as ferramentas 
  // gerenciam o estado da personalidade diretamente no banco/Redis.
  buildContextBlock: async () => '',
  
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