// lib/modules/modules/localizacao.ts
// V13.0.0 — Arquitetura V2 (Sinal de fumaça): Zero DB Calls + Payload enxuto

import type { ModuleDefinition } from '../types';

export const ModuloLocalizacao: ModuleDefinition = {
  id: 'localizacao',
  label: 'Geolocalização Inteligente',
  preferredModel: 'flash',
  plan: 'free',
  version: 'v2', // ← OFICIALMENTE V2
  trigger: {
    always: true,
    condition: async (opts) => !!opts.location
  },
  
  buildContextBlock: async (opts) => {
    if (!opts.location) return '';
    
    try {
      // ✅ Injeção limpa e simples (RAM).
      const lat = opts.location.latitude?.toFixed(4);
      const lng = opts.location.longitude?.toFixed(4);
      const injectedLocations = (opts as any).masterContext?.locations || [];
      
      // V2: Reduz a injeção detalhada de lugares para manter o System Prompt focado e leve.
      return `[Módulo: Localização] Ativo nas coordenadas (${lat}, ${lng}). O radar de contexto detectou ${injectedLocations.length} lugar(es) conhecido(s) na região. Use a tool 'buscar_lugares_proximos' para consultar detalhes e novos locais nos arredores.`;
    } catch {
      return '';
    }
  },
  
  tools: ['buscar_lugares_proximos'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
