// lib/insights/document-insights.ts
import { supabase } from '../supabase';
import { callOpenRouter } from '../chat/openrouter';
import { getCachedInsight, setCachedInsight } from './insight-cache';

export async function getDocumentInsight(userId: string): Promise<string> {
  const cacheKey = `document_insight_${userId}`;
  const cached = getCachedInsight(cacheKey);
  if (cached) return cached;

  const { data } = await supabase
    .from('documents')
    .select('label, expires_at')
    .eq('user_id', userId)
    .order('expires_at', { ascending: true })
    .limit(3);

  if (!data || data.length === 0) {
    const noDocMsg = 'Nenhum documento cadastrado.';
    setCachedInsight(cacheKey, noDocMsg, 7200);
    return noDocMsg;
  }

  const today = new Date().toISOString().slice(0, 10);
  const docsWithDays = data.map(doc => {
    const days = Math.ceil((new Date(doc.expires_at).getTime() - new Date(today).getTime()) / 86400000);
    return { ...doc, days };
  });

  const prompt = `
Documentos do usuário:
${docsWithDays.map(d => `${d.label}: vence em ${d.days} dias`).join('\n')}

Escreva uma frase curta (máx 20 palavras) alertando sobre o documento mais urgente, se houver. Se nenhum vencer em menos de 7 dias, diga "Nada urgente por enquanto."
`;

  const response = await callOpenRouter([{ role: 'user', content: prompt }], 'gpt-3.5-turbo', 0.7, 150);
  const insight = response.content.trim();
  setCachedInsight(cacheKey, insight, 1800); // 30 minutos
  return insight;
}