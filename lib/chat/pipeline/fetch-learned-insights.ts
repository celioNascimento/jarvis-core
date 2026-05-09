// lib/chat/fetch-learned-insights.ts
// Busca os learned_insights ativos do usuário para injeção no system prompt.
//
// Ordenado por confidence_score desc — os mais consolidados aparecem primeiro.
// Limitado a 20 para não inflar o contexto desnecessariamente.

import { supabase } from '@/lib/jarvis';

export async function fetchLearnedInsights(userId: string): Promise<string> {
  try {
    const { data, error } = await supabase
      .schema('jarvis')
      .from('learned_insights')
      .select('insight_text, source_type, confidence_score')
      .eq('user_id', Number(userId))
      .eq('is_active', true)
      .order('confidence_score', { ascending: false })
      .limit(20);

    if (error || !data?.length) return '';

    // Agrupa por source_type para deixar o bloco legível no prompt
    const confirmed = data.filter(i => i.source_type === 'user_confirmed' || i.source_type === 'user_corrected');
    const inferred  = data.filter(i => i.source_type === 'inferred');

    const lines: string[] = [];

    if (confirmed.length) {
      lines.push('📌 Preferências confirmadas:');
      confirmed.forEach(i => lines.push(`- ${i.insight_text}`));
    }

    if (inferred.length) {
      lines.push('🔍 Padrões observados:');
      inferred.forEach(i => lines.push(`- ${i.insight_text} (confiança: ${(i.confidence_score * 100).toFixed(0)}%)`));
    }

    return lines.join('\n');
  } catch {
    return ''; // silencioso — nunca trava o prompt
  }
}