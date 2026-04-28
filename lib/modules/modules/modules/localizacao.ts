import type { ModuleDefinition } from '../types';
import { checkProximidade } from '@/lib/geo';

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
      const geoCtx = await checkProximidade(opts.location.latitude, opts.location.longitude, opts.userId);
      return `[MÓDULO LOCALIZAÇÃO]\n${geoCtx}`;
    } catch {
      return '';
    }
  },
  tools: ['buscar_lugares_proximos'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
