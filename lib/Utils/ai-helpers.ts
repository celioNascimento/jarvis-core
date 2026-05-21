// lib/utils/ai-helpers.ts

/**
 * Chama a IA garantindo o formato JSON.
 * Mantido como callAI para não quebrar os imports do extractor.ts
 */

import type { PersonalitySettings } from '@/lib/services/personality.service';

export async function callAI(prompt: string, maxTokens = 300): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('[callAI] Nenhuma API key encontrada (OPENAI_API_KEY ou OPENROUTER_API_KEY)');
    throw new Error('API key ausente');
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.0-flash-001',
      max_tokens: maxTokens,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[callAI] HTTP erro:', res.status, err.slice(0, 200));
    throw new Error(`callAI HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '');
  
  if (!text) {
    console.error('[callAI] Resposta vazia:', JSON.stringify(data).slice(0, 200));
    throw new Error('callAI resposta vazia');
  }
  
  return text;
}

/**
 * Aliás para manter compatibilidade com o extractor-jobs.ts novo
 */
export async function callAIExtractor(prompt: string, maxTokens = 300): Promise<string> {
  return callAI(prompt, maxTokens);
}

/**
 * Tenta fazer o parse seguro de um JSON, corrigindo erros comuns do LLM
 */
export function safeParseJSON(raw: string): any | null {
  // O uso de [`]{3} impede que editores e markdown quebrem a string
  const clean = raw.replace(/[`]{3}json|[`]{3}/gi, '').trim();
  
  try {
    return JSON.parse(clean);
  } catch {
    let fixed = clean;
    fixed = fixed.replace(/,?\s*"[^"]*":\s*"[^"]*$/, '');
    fixed = fixed.replace(/,?\s*"[^"]*":\s*$/, '');
    
    if ((fixed.match(/"/g) || []).length % 2 !== 0) fixed += '"';
    
    const opens = (fixed.match(/\{/g) || []).length;
    const closes = (fixed.match(/\}/g) || []).length;
    const aOpens = (fixed.match(/\[/g) || []).length;
    const aCloses = (fixed.match(/\]/g) || []).length;
    
    for (let i = 0; i < aOpens - aCloses; i++) fixed += ']';
    for (let i = 0; i < opens - closes; i++) fixed += '}';
    
    try {
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}

const PERSONALITY_DEFAULTS: PersonalitySettings = {
  humor: 50,
  franqueza: 80,
  formalidade: 20,
  modo_escuta: 70,
};

/**
 * Constrói o bloco de learned_insights a partir do masterContext.
 * Substitui fetchLearnedInsights() — zero queries ao banco.
 */
export function buildLearnedInsightsBlock(insights: any[]): string {
  if (!insights?.length) return '';

  const confirmed = insights.filter(i =>
    i.source_type === 'user_confirmed' || i.source_type === 'user_corrected'
  );
  const inferred = insights.filter(i => i.source_type === 'inferred');

  const lines: string[] = [];

  if (confirmed.length) {
    lines.push('📌 Preferências confirmadas:');
    confirmed.forEach(i => lines.push(`- ${i.insight_text}`));
  }
  if (inferred.length) {
    lines.push('🔍 Padrões observados:');
    inferred.forEach(i =>
      lines.push(`- ${i.insight_text} (confiança: ${(i.confidence_score * 100).toFixed(0)}%)`)
    );
  }

  return lines.join('\n');
}

/**
 * Reconstrói PersonalitySettings a partir do masterContext.settings.
 * Substitui getPersonalitySettings() — zero queries ao banco.
 * Aceita tanto objeto key:value quanto array de rows {key, value}.
 */
export function buildPersonalityFromContext(settings: any): PersonalitySettings {
  if (!settings) return PERSONALITY_DEFAULTS;

  if (Array.isArray(settings)) {
    const result = { ...PERSONALITY_DEFAULTS };
    for (const row of settings) {
      if (row.key in result) (result as any)[row.key] = row.value;
    }
    return result;
  }

  return {
    humor:       settings.humor       ?? PERSONALITY_DEFAULTS.humor,
    franqueza:   settings.franqueza   ?? PERSONALITY_DEFAULTS.franqueza,
    formalidade: settings.formalidade ?? PERSONALITY_DEFAULTS.formalidade,
    modo_escuta: settings.modo_escuta ?? PERSONALITY_DEFAULTS.modo_escuta,
  };
}