import type { ModuleDefinition } from '../types';

export const ModuloDossie: ModuleDefinition = {
  id:             'dossie',
  label:          'Dossiê',
  preferredModel: 'flash',
  plan:           'free',
  tools:          ['dossie_atualizar', 'dossie_consultar'],
  trigger: {
    always: true,
  },
  buildContextBlock: async () => '',
  metrics: {
    avgTokens:       0,
    avgLatencyMs:    0,
    activationCount: 0,
  },
};