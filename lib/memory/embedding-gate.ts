// lib/memory/embedding-gate.ts
// V2.0 — Decisão pura: recebe dados do pipeline, retorna boolean.
// Adicionado: parâmetro `message` para detectar perguntas de memória explícitas
// sem depender do classificador L4.

import type { ContextType } from '@/lib/chat/context-classifier';

// Contextos que justificam busca semântica na memória HD
const MEMORY_CONTEXTS: ContextType[] = [
  'emocao',
  'familia',
  'diario',
  'retrospecto',
  'saude',
  'meta',
  'relacao',
];

// Regex de perguntas de memória — garante passagem mesmo sem contexto L4
// FIX: sem isso, "você lembra do flerte?" era bloqueado por não ter score emocional alto
const MEMORY_QUERY_REGEX = /\b(lembra|lembrar|falamos|comentei|disse que|você sabe que|contei|mencionei|te falei|a gente conversou|aquela vez|antes você|já te falei)\b/i;

/**
 * Decide se o pipeline deve gerar embedding e buscar memórias relevantes.
 *
 * Critérios (qualquer um ativa):
 * - Pergunta explícita de memória (via regex) — ativa independente de tudo
 * - Score emocional alto (> 0.5)
 * - Contexto retrospectivo, familiar, emocional, saúde
 *
 * Nunca ativa para:
 * - Mensagens de ruído (exceto se for pergunta de memória)
 * - Contextos puramente operacionais (financas, veiculos, clima, compras)
 */
export function shouldRetrieveMemory(
  contexts: ContextType[],
  emotionalScore: number,
  isNoise: boolean,
  message?: string,
): boolean {
  // Pergunta explícita de memória sempre passa — não importa score ou noise
  if (message && MEMORY_QUERY_REGEX.test(message)) return true;

  if (isNoise) return false;
  if (emotionalScore > 0.5) return true;
  return contexts.some(c => MEMORY_CONTEXTS.includes(c));
}
