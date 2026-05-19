import type { ModuleDefinition } from '../types';

export const ModuloPersonalidade: ModuleDefinition = {
  id:             'personalidade',
  label:          'Personalidade',
  preferredModel: 'flash',
  plan:           'free',
  tools:          ['personalidade_ajustar', 'personalidade_consultar'],
  trigger: {
    always:   false,
    keywords: /humor|franqueza|formalidade|escuta|personalidade|tom|direto|leveza|relaxa|mais (sério|formal|informal|presente)/i,
    contexts: [],
  },
  buildContextBlock: async () => '',
  metrics: {
    avgTokens:       0,
    avgLatencyMs:    0,
    activationCount: 0,
  },
};