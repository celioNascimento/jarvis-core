// lib/insights/holiday-insights.ts
import { getUpcomingHolidays } from '../holidays'; // ajuste para sua função real
import { callOpenRouter } from '../chat/openrouter';
import { getCachedInsight, setCachedInsight } from './insight-cache';

export async function getHolidayInsight(userId: string): Promise<string> {
  const cacheKey = `holiday_insight_${userId}`;
  const cached = getCachedInsight(cacheKey);
  if (cached) return cached;

  const holidays = await getUpcomingHolidays(3);
  if (!holidays.length) {
    const noHolidayMsg = 'Não há feriados previstos nos próximos dias.';
    setCachedInsight(cacheKey, noHolidayMsg, 3600); // 1 hora
    return noHolidayMsg;
  }

  const prompt = `
Lista de próximos feriados:
${holidays.map(h => `${h.name}: ${h.date}`).join('\n')}

Gere uma frase curta (máx 20 palavras) informando o próximo feriado e, se faltar menos de 7 dias, um lembrete útil. Exemplo: "Daqui a 3 dias é Tiradentes – já pensou em descansar?"
`;

  const response = await callOpenRouter([{ role: 'user', content: prompt }], 'gpt-3.5-turbo', 0.7, 150);
  const insight = response.content.trim();
  setCachedInsight(cacheKey, insight, 3600);
  return insight;
}