// lib/modules/modules/clima.ts
// V13.0.0 — STRICT REGRA 3: Zero API Calls na entrada + Arquitetura V2 (Sinal de fumaça)

import type { ModuleDefinition } from '../types';
// fetchWeather removido do import, a responsabilidade de I/O passa a ser exclusiva da tool.

export const ModuloClima: ModuleDefinition = {
  id: 'clima',
  label: 'Condições Climáticas',
  preferredModel: 'flash',
  plan: 'free',
  version: 'v2', // ← OFICIALMENTE V2
  trigger: {
    contexts: ['clima'],
    keywords: /clima|tempo|chover|chuva|sol|frio|calor|previsão|temperatura|guarda-chuva/i,
  },

  buildContextBlock: async (opts) => {
    try {
      // Prioridade 1: GPS atual do request (opts.location)
      // Prioridade 2: última localização no masterContext.config
      // Prioridade 3: fallback hardcoded
      let lat = -23.27; // Londrina
      let lon = -51.2;

      if (opts.location?.latitude && opts.location?.longitude) {
        lat = Number(opts.location.latitude);
        lon = Number(opts.location.longitude);
      } else {
        const locKey = `last_location_${opts.userId}`;
        const masterConfig = (opts as any).masterContext?.config;
        const locValueStr = masterConfig?.[locKey];

        if (locValueStr) {
          try {
            const parsed = typeof locValueStr === 'string'
              ? JSON.parse(locValueStr)
              : locValueStr;
            if (parsed.latitude && parsed.longitude) {
              lat = parseFloat(parsed.latitude);
              lon = parseFloat(parsed.longitude);
            }
          } catch {
            console.warn('[ModuloClima] Erro ao parsear localização do config');
          }
        }
      }

      // V2: Fetch externo removido do pipeline de injeção. Zero latência na montagem.
      return `[Módulo: Clima] Localização resolvida (Lat: ${lat}, Lon: ${lon}). Use a tool 'clima_consultar_atual' para buscar a temperatura real, previsão de chuva e condições do tempo.`;
    } catch (e) {
      console.error('[ModuloClima] Erro:', e);
      return '';
    }
  },

  tools: ['clima_consultar_atual'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 },
};
