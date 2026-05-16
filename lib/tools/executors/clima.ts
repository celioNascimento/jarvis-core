// lib/tools/executors/clima.ts
// V1.0.2 — Proteção Absoluta contra Coordenadas Inválidas (Anti-NaN)

import { supabase } from '@/lib/jarvis';
import { fetchWeather } from '@/lib/openmeteo';

export async function executeConsultarClimaAtual(_p: any, _authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = Number(numericUserId);
    
    // 1. Busca a última localização conhecida do usuário
    const { data: locData } = await supabase
      .schema('jarvis')
      .from('config')
      .select('value')
      .eq('key', `last_location_${targetId}`)
      .limit(1)
      .maybeSingle();

    // Fallback padrão e seguro: Londrina/PR
    let lat = -23.27;
    let lon = -51.2;

    if (locData?.value) {
      try {
        const parsed = JSON.parse(locData.value);
        const parsedLat = parseFloat(parsed.latitude);
        const parsedLon = parseFloat(parsed.longitude);

        // 🔥 VALIDAÇÃO CRÍTICA: Só substitui o fallback se os números forem reais e válidos
        if (!isNaN(parsedLat) && !isNaN(parsedLon) && parsedLat !== 0 && parsedLon !== 0) {
          lat = parsedLat;
          lon = parsedLon;
        }
      } catch {
        // Se o JSON estiver corrompido, mantém Londrina silenciosamente
      }
    }

    // Limita a 4 casas decimais (padrão ideal para APIs de mapa/clima)
    lat = Number(lat.toFixed(4));
    lon = Number(lon.toFixed(4));

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
    console.error('[executeConsultarClimaAtual] Erro:', err.message);
    return `Não foi possível obter as condições climáticas agora devido a uma falha de comunicação com o serviço meteorológico.`;
  }
}
