// lib/utils/ai-helpers.ts — V14.1 (Rigor de Contrato: Tipagem Estrita e Gateway)

import type { PersonalitySettings } from '@/lib/services/personality.service';
import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway';

// ── TIPAGENS ESTRITAS ────────────────────────────────────────

export interface InsightItem {
  source_type: 'user_confirmed' | 'user_corrected' | 'inferred' | string;
  insight_text: string;
  confidence_score: number;
}

export interface SettingRow {
  key: keyof PersonalitySettings;
  value: number;
}

export type SettingsMap = Partial<PersonalitySettings>;

// ── LLM GATEWAY WRAPPERS (Regra 4) ───────────────────────────

/**
 * Chama a IA garantindo o formato de texto, passando pelo Gateway 
 * para controle de I/O e concorrência em Tarefas de Fundo (Prioridade 3).
 */
export async function callAI(prompt: string, maxTokens = 300): Promise<string> {
  const res = await callOpenRouterWithPriority(
    3, 
    'queue', 
    `callAI_${Date.now()}`, 
    [{ role: 'user', content: prompt }], 
    undefined, 
    'google/gemini-2.0-flash-001',
    0.1, 
    20000, 
    maxTokens
  );

  if (!res.content) {
    console.error('[callAI] Gateway retornou conteúdo vazio para a extração.');
    throw new Error('callAI resposta vazia');
  }

  return res.content;
}

/**
 * Aliás para manter compatibilidade com módulos legados.
 */
export async function callAIExtractor(prompt: string, maxTokens = 300): Promise<string> {
  return callAI(prompt, maxTokens);
}

// ── PARSERS SEGUROS ──────────────────────────────────────────

/**
 * Tenta fazer o parse seguro de um JSON, corrigindo erros comuns do LLM.
 * Retorna unknown para forçar o chamador a fazer o cast/validação (Rigor TypeScript).
 */
export function safeParseJSON(raw: string): unknown | null {
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

// ── CONSTRUTORES PUROS (Regra 3: Zero I/O) ───────────────────

const PERSONALITY_DEFAULTS: PersonalitySettings = {
  humor: 50,
  franqueza: 80,
  formalidade: 20,
  modo_escuta: 70,
};

/**
 * Constrói o bloco de learned_insights a partir do masterContext.
 */
export function buildLearnedInsightsBlock(insights: InsightItem[] | undefined | null): string {
  if (!insights || insights.length === 0) return '';

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
 */
export function buildPersonalityFromContext(settings: SettingRow[] | SettingsMap | undefined | null): PersonalitySettings {
  if (!settings) return PERSONALITY_DEFAULTS;

  if (Array.isArray(settings)) {
    const result = { ...PERSONALITY_DEFAULTS };
    for (const row of settings) {
      if (row.key in result) {
        result[row.key] = row.value;
      }
    }
    return result;
  }

  // Se for um objeto SettingsMap
  return {
    humor:       settings.humor       ?? PERSONALITY_DEFAULTS.humor,
    franqueza:   settings.franqueza   ?? PERSONALITY_DEFAULTS.franqueza,
    formalidade: settings.formalidade ?? PERSONALITY_DEFAULTS.formalidade,
    modo_escuta: settings.modo_escuta ?? PERSONALITY_DEFAULTS.modo_escuta,
  };
}