// lib/modules/modules/localizacao.ts
// V12 — Zero DB Calls (Extrai dados do masterContext)
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
