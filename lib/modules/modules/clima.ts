// lib/modules/modules/clima.ts
// V12.4.0 — Zero DB Calls — usa opts.location do pipeline

import type { ModuleDefinition } from '../types';
import { fetchWeather } from '@/lib/openmeteo';

export const ModuloClima: ModuleDefinition = {
  id: 'clima',
  label: 'Condições Climáticas',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['clima'],
    keywords: /clima|tempo|chover|chuva|sol|frio|calor|previsão|temperatura|guarda-chuva/i,
  },

  buildContextBlock: async (opts) => {
    try {
      // Prioridade 1: GPS atual do request (opts.location)
      // Prioridade 2: última localização no masterContext.config
      // Prioridade 3: fallback hardcoded Londrina
      let lat = -23.27;
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

      // fetchWeather é API externa — não é query ao banco, é legítimo
      const weather = await fetchWeather(lat, lon);

      return `[MÓDULO DE CLIMA ATIVO]
A localização atual do usuário registra ${weather.temp}°C (${weather.description}).
Umidade: ${weather.humidity}% | Chance de chuva hoje: ${weather.forecast[0]?.rain_probability || 0}%.`;
    } catch (e) {
      console.error('[ModuloClima] Erro:', e);
      return '';
    }
  },

  tools: ['clima_consultar_atual'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 },
};
