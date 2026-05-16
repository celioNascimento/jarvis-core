// lib/tools/executors/clima.ts
// V1.0.0 — Executor de Clima Integrado à Localização GPS e Open-Meteo

import { supabase } from '@/lib/jarvis';
import { fetchWeather } from '@/lib/openmeteo'; // Sua função já existente

export async function executeConsultarClimaAtual(_p: any, _authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = Number(numericUserId);
    
    // 1. Busca a última localização conhecida do usuário na SSOT
    const { data: locData } = await supabase
      .schema('jarvis')
      .from('config')
      .select('value')
      .eq('key', `last_location_${targetId}`)
      .limit(1)
      .maybeSingle();

    // Fallback: Londrina se não tiver GPS salvo
    let lat = -23.27;
    let lon = -51.2;

    if (locData?.value) {
      try {
        const parsed = JSON.parse(locData.value);
        lat = parseFloat(parsed.latitude);
        lon = parseFloat(parsed.longitude);
      } catch { /* Usa o fallback silenciosamente */ }
    }

    // 2. Busca o Clima no Open-Meteo
    const weather = await fetchWeather(lat, lon);

    // 3. Monta a resposta formatada para a IA ler
    let out = `[CONDIÇÕES ATUAIS]\nTemperatura: ${weather.temp}°C\nCondição: ${weather.description}\nUmidade: ${weather.humidity}%\nVento: ${weather.wind_speed} km/h\n\n`;
    
    out += `[PREVISÃO DOS PRÓXIMOS 3 DIAS]\n`;
    weather.forecast.slice(0, 3).forEach((f: any) => {
      out += `- ${f.date}: Mín ${f.min}°C | Máx ${f.max}°C | Chance de Chuva: ${f.rain_probability}%\n`;
    });

    return out;
  } catch (err: any) {
    return `Erro ao consultar o clima: ${err.message}`;
  }
}
