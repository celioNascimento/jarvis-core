// lib/modules/modules/dossie.ts
// V12.3.0 — Padrão mantido: Zero DB Calls Nativo (Orientado a Ferramentas)

import type { ModuleDefinition } from '../types';

export const ModuloDossie: ModuleDefinition = {
  id: 'dossie',
  label: 'Dossiê',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    always: true, // Seguro manter true, pois não consome I/O nem tokens na entrada
  },
  
  // O Dossiê é operado sob demanda pelas tools, preservando a janela de contexto.
  buildContextBlock: async () => '',
  
  tools: [
    'dossie_atualizar', 
    'dossie_consultar'
  ],
  
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 },
};