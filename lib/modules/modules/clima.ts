// lib/modules/modules/clima.ts
// V12.3.0 — Zero DB Calls (Uso do config consolidado) e Fallback de Hidratação

import { supabase } from '@/lib/jarvis';
import type { ModuleDefinition } from '../types';
import { fetchWeather } from '@/lib/openmeteo';

export const ModuloClima: ModuleDefinition = {
  id: 'clima',
  label: 'Condições Climáticas',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['clima'], 
    keywords: /clima|tempo|chover|chuva|sol|frio|calor|previsão|temperatura|guarda-chuva/i
  },
  
  buildContextBlock: async (opts) => {
    try {
      let lat = -23.27, lon = -51.2; // Fallback hardcoded (Londrina)
      const locKey = `last_location_${opts.userId}`;

      // 1. Tenta a Injeção de Contexto (O God RPC traz todas as configs)
      const masterConfig = (opts as any).masterContext?.config;
      let locValueStr = masterConfig ? masterConfig[locKey] : null;

      // 2. Fallback de Segurança (Se chamado isoladamente)
      if (!masterConfig) {
        const { data: locData } = await supabase
          .schema('jarvis')
          .from('config')
          .select('value')
          .eq('key', locKey)
          .maybeSingle();
        
        locValueStr = locData?.value;
      }

      // 3. Processamento dos Dados
      if (locValueStr) {
        try {
          // O JSON pode já vir parseado do masterContext ou como string do banco
          const parsed = typeof locValueStr === 'string' ? JSON.parse(locValueStr) : locValueStr;
          if (parsed.latitude && parsed.longitude) {
            lat = parseFloat(parsed.latitude); 
            lon = parseFloat(parsed.longitude);
          }
        } catch (e) {
          console.warn('[ModuloClima] Erro ao parsear localização:', e);
        }
      }

      // Mantém a chamada à API de clima (não afeta o Supabase)
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