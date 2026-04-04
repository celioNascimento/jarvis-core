// lib/insights/holiday-insights.ts
import { getUpcomingHolidays } from '@/lib/holidays';
import { callOpenRouterWithTools } from '@/lib/chat/openrouter';
import { getCachedInsight, setCachedInsight } from './insight-cache';

export async function getHolidayInsight(userId: string): Promise<string> {
  const cacheKey = `holiday_insight_${userId}`;
  const cached = getCachedInsight(cacheKey);
  if (cached) return cached;

  const holidays = await getUpcomingHolidays(3);
  if (!holidays.length) {
    const msg = 'Não há feriados previstos nos próximos dias.';
    setCachedInsight(cacheKey, msg, 3600);
    return msg;
  }

  const prompt = `Lista de próximos feriados:\n${holidays.map(h => `${h.name}: ${h.date}`).join('\n')}\nGere uma frase curta (máx 20 palavras) informando o próximo feriado e, se faltar menos de 7 dias, um lembrete útil.`;

  const response = await callOpenRouterWithTools(
    [{ role: 'user', content: prompt }],
    [],
    'gpt-3.5-turbo',
    0.7,
    150
  );
  const insight = response.content.trim();
  setCachedInsight(cacheKey, insight, 3600);
  return insight;
}