// lib/insights/weather-insights.ts
import { fetchWeather } from '../openmeteo';
import { callOpenRouter } from '../chat/openrouter';
import { getCachedInsight, setCachedInsight } from './insight-cache';

export async function getWeatherInsight(
  lat: number,
  lon: number,
  userName?: string
): Promise<string> {
  const cacheKey = `weather_insight_${lat}_${lon}`;
  const cached = getCachedInsight(cacheKey);
  if (cached) return cached;

  const weather = await fetchWeather(lat, lon);
  const today = weather.forecast[0];
  const prompt = `
Você é um assistente pessoal prestativo. Com base nos seguintes dados climáticos para o usuário (nome: ${userName || 'usuário'}):
- Temperatura atual: ${weather.temp}°C
- Condição: ${weather.description} (código ${weather.condition_code})
- Umidade: ${weather.humidity}%
- Probabilidade de chuva hoje: ${today?.rain_probability ?? 0}%
- Máxima hoje: ${today?.max ?? '?'}°C, Mínima: ${today?.min ?? '?'}°C

Escreva UMA frase curta (máximo 20 palavras) que seja útil e prática. Dê um conselho simples: levar guarda-chuva, aproveitar o sol, evitar sair, etc. Seja amigável, direto, sem rodeios. Não invente informações adicionais.
`;

  const response = await callOpenRouter([{ role: 'user', content: prompt }], 'gpt-3.5-turbo', 0.7, 150);
  const insight = response.content.trim();
  setCachedInsight(cacheKey, insight, 300); // 5 minutos
  return insight;
}