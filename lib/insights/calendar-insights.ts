// lib/insights/calendar-insights.ts
import { getGoogleContext } from '@/lib/google';
import { getMicrosoftCalendarContext } from '@/lib/microsoft';
import { callOpenRouterWithTools } from '@/lib/chat/openrouter';
import { getCachedInsight, setCachedInsight } from './insight-cache';

export async function getCalendarInsight(userId: string, authUserId: string): Promise<string> {
  const cacheKey = `calendar_insight_${userId}`;
  const cached = getCachedInsight(cacheKey);
  if (cached) return cached;

  const googleEvents = await getGoogleContext().catch(() => null);
  const outlookEvents = await getMicrosoftCalendarContext().catch(() => null);

  let eventsText = '';
  if (googleEvents) eventsText += `Google:\n${googleEvents}\n`;
  if (outlookEvents) eventsText += `Outlook:\n${outlookEvents}\n`;

  if (!eventsText.trim()) {
    const msg = 'Nenhum evento importante nos próximos dias.';
    setCachedInsight(cacheKey, msg, 3600);
    return msg;
  }

  const prompt = `Eventos do usuário nos próximos dias:\n${eventsText}\nEscreva uma frase curta (máx 25 palavras) destacando o compromisso mais relevante. Se houver evento hoje ou amanhã, avise. Se não houver nada urgente, diga "Agenda tranquila."`;

  const response = await callOpenRouterWithTools(
    [{ role: 'user', content: prompt }],
    [],
    'gpt-3.5-turbo',
    0.7,
    150
  );
  const insight = response.content.trim();
  setCachedInsight(cacheKey, insight, 1800);
  return insight;
}