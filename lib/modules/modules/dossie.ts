// lib/modules/modules/dossie.ts
// V13.0.0 — Migrado para V2 (Arquitetura Cache/RAM): Emite sinal de fumaça ao invés de vazio

import type { ModuleDefinition } from '../types';

export const ModuloDossie: ModuleDefinition = {
  id: 'dossie',
  label: 'Dossiê',
  preferredModel: 'flash',
  plan: 'free',
  // @ts-ignore - Flag temporária até atualizarmos a interface ModuleDefinition no types.ts
  version: 'v2', 
  trigger: {
    always: true, // Seguro manter true, pois apenas emite o sinal de fumaça
  },
  
  // O Dossiê opera sob demanda (RAM). Injetamos apenas o "sinal de fumaça" no Cache (Prompt).
  buildContextBlock: async () => {
    return `[Módulo: Dossiê] Ativo. Use a tool 'dossie_consultar' para ler informações de longo prazo do usuário, ou 'dossie_atualizar' para registrar novos fatos importantes.`;
  },
  
  tools: [
    'dossie_atualizar', 
    'dossie_consultar'
  ],
  
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 },
};
