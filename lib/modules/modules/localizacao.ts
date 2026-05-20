// lib/modules/modules/localizacao.ts
// V12.3.0 — Padrão consolidado: Zero DB Calls (Uso exclusivo de dados injetados)

import type { ModuleDefinition } from '../types';

export const ModuloLocalizacao: ModuleDefinition = {
  id: 'localizacao',
  label: 'Geolocalização Inteligente',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    always: true,
    condition: async (opts) => !!opts.location
  },
  
  buildContextBlock: async (opts) => {
    if (!opts.location) return '';
    
    try {
      // ✅ Injeção limpa e simples. Sem ir ao banco.
      // O masterContext já contém os dados processados pelo radar/RPC
      const lat = opts.location.latitude?.toFixed(4);
      const lng = opts.location.longitude?.toFixed(4);
      const injectedLocations = (opts as any).masterContext?.locations || [];
      
      let ctx = `[MÓDULO LOCALIZAÇÃO]\n📍 Coordenadas Atuais: ${lat}, ${lng}`;
      
      if (injectedLocations.length > 0) {
        ctx += `\nLugares conhecidos próximos (extraídos do radar): ${injectedLocations.map((l: any) => l.name).join(', ')}`;
      }
      
      return ctx;
    } catch {
      return '';
    }
  },
  
  tools: ['buscar_lugares_proximos'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};