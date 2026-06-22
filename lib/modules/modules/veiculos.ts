// lib/modules/modules/veiculos.ts
// V13.0.0 — Arquitetura V2 (Sinal de fumaça): Payload enxuto e Zero DB Calls

import type { ModuleDefinition } from '../types';

export const ModuloVeiculos: ModuleDefinition = {
  id: 'veiculos',
  label: 'Gestão de Veículos (ExpertFrotas)',
  preferredModel: 'flash',
  plan: 'personal',
  version: 'v2', // ← OFICIALMENTE V2
  trigger: {
    contexts: ['veiculos'],
    keywords: /carro|veículo|placa|km|óleo|gasolina|etanol|manutenção|multa/i,
  },

  buildContextBlock: async (opts) => {
    try {
      // ✅ Injeção limpa via masterContext (RAM)
      const vehicles = (opts as any).masterContext?.vehicles || [];

      if (!vehicles.length) return '';

      // V2: Substituição do cruzamento de arrays e strings longas pelo sinal de fumaça.
      return `[Módulo: Veículos (ExpertFrotas)] Há ${vehicles.length} veículo(s) registrado(s) no masterContext. Use a tool 'consultar_veiculos' para ver KM atual, histórico de manutenções e abastecimentos. Para registros e atualizações, use 'atualizar_odometro', 'registrar_manutencao' ou 'registrar_abastecimento'.`;
    } catch (e) {
      console.error('[ModuloVeiculos] Erro no build:', e);
      return '';
    }
  },

  tools: [
    'consultar_veiculos', // ← Nova tool adicionada para permitir a leitura sob demanda
    'registrar_manutencao', 
    'registrar_abastecimento', 
    'atualizar_odometro'
  ],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 },
};
