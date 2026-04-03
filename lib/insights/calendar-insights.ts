// lib/insights/calendar-insights.ts
import { getGoogleContext, getMicrosoftCalendarContext } from '../google'; // ajuste
import { callOpenRouter } from '../chat/openrouter';
import { getCachedInsight, setCachedInsight } from './insight-cache';

export async function getCalendarInsight(userId: string, authUserId: string): Promise<string> {
  const cacheKey = `calendar_insight_${userId}`;
  const cached = getCachedInsight(cacheKey);
  if (cached) return cached;

  // Busca eventos dos próximos 7 dias (Google + Outlook)
  const googleEvents = await getGoogleContext(7).catch(() => null);
  const outlookEvents = await getMicrosoftCalendarContext(7).catch(() => null);

  let eventsText = '';
  if (googleEvents) eventsText += `Google:\n${googleEvents}\n`;
  if (outlookEvents) eventsText += `Outlook:\n${outlookEvents}\n`;

  if (!eventsText.trim()) {
    const noEventsMsg = 'Nenhum evento importante nos próximos dias.';
    setCachedInsight(cacheKey, noEventsMsg, 3600);
    return noEventsMsg;
  }

  const prompt = `
Eventos do usuário nos próximos dias:
${eventsText}

Escreva uma frase curta (máx 25 palavras) destacando o compromisso mais relevante (ex: reunião, aniversário, prazo). Se houver evento hoje ou amanhã, avise. Se não houver nada urgente, diga "Agenda tranquila."
`;

  const response = await callOpenRouter([{ role: 'user', content: prompt }], 'gpt-3.5-turbo', 0.7, 150);
  const insight = response.content.trim();
  setCachedInsight(cacheKey, insight, 1800);
  return insight;
}