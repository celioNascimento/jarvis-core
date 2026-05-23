// lib/memory/embedding-gate.ts
// Responsabilidade única: decidir se a busca semântica de memória deve ocorrer.
// Função pura — zero I/O, zero await, zero banco.
// Regra 3: recebe dados já disponíveis no pipeline, retorna boolean.

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

/**
 * Decide se o pipeline deve gerar embedding e buscar memórias relevantes.
 *
 * Critérios (qualquer um ativa):
 * - Score emocional alto (> 0.5) — conversa com carga emocional real
 * - Contexto retrospectivo — usuário referenciando o passado
 * - Contexto familiar/emocional/saúde — temas que se beneficiam de histórico
 *
 * Nunca ativa para:
 * - Mensagens de ruído (muito curtas ou padrão trivial)
 * - Contextos puramente operacionais (financas, veiculos, clima, compras)
 */
export function shouldRetrieveMemory(
  contexts: ContextType[],
  emotionalScore: number,
  isNoise: boolean,
): boolean {
  if (isNoise) return false;
  if (emotionalScore > 0.5) return true;
  return contexts.some(c => MEMORY_CONTEXTS.includes(c));
}