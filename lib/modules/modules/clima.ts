// lib/modules/modules/clima.ts
// V1.0.1 — Correção de ContextType para Build

import { supabase } from '@/lib/jarvis';
import type { ModuleDefinition } from '../types';
import { fetchWeather } from '@/lib/openmeteo';

export const ModuloClima: ModuleDefinition = {
  id: 'clima',
  label: 'Condições Climáticas',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['clima'], // ← Mantido apenas o contexto válido no enum do sistema
    keywords: /clima|tempo|chover|chuva|sol|frio|calor|previsão|temperatura|guarda-chuva/i
  },
  
  buildContextBlock: async (opts) => {
    try {
      const { data: locData } = await supabase
        .schema('jarvis')
        .from('config')
        .select('value')
        .eq('key', `last_location_${opts.userId}`)
        .maybeSingle();

      let lat = -23.27, lon = -51.2;
      if (locData?.value) {
        const parsed = JSON.parse(locData.value);
        lat = parseFloat(parsed.latitude); 
        lon = parseFloat(parsed.longitude);
      }

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
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
