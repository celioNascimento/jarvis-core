// lib/chat/pipeline/prompts/memory-block.ts
//
// Regra 3 — Módulo puro:
//   ✅ Lê masterContext.memories → retorna string
//   ❌ Nunca await supabase
//   ❌ Nunca await fetch
//
// Se memories não veio no masterContext, retorna vazio e registra warn.

import type { MemoryRecord } from '@/lib/data/memories.data';

interface MemoryBlockInput {
  masterContext: {
    memories?:         MemoryRecord[];
    topEmotionalMemories?: MemoryRecord[];
  };
}

/**
 * Formata memórias relevantes para injeção no system prompt.
 *
 * Separa em dois blocos:
 * 1. Memórias semanticamente similares à conversa atual (rankeadas por effective_score)
 * 2. Memórias de alto peso emocional (sempre presentes quando existem)
 *
 * O segundo bloco garante que experiências de alto impacto emocional
 * nunca sejam esquecidas mesmo quando semanticamente distantes da mensagem atual.
 */
export function buildMemoryBlock(input: MemoryBlockInput): string {
  const { masterContext } = input;

  if (!masterContext?.memories) {
    console.warn('[memory-block] masterContext.memories ausente — bloco omitido');
    return '';
  }

  const memories     = masterContext.memories ?? [];
  const topEmotional = masterContext.topEmotionalMemories ?? [];

  if (!memories.length && !topEmotional.length) return '';

  const blocks: string[] = ['[MEMÓRIAS RELEVANTES]'];

  // ── Memórias por relevância semântica ────────────────────────────────────
  if (memories.length > 0) {
    blocks.push('Relacionadas à conversa atual:');
    memories.forEach(m => {
      const score    = m.effective_score ? ` (relevância: ${Math.round(m.effective_score * 100)}%)` : '';
      const category = m.category !== 'info' ? ` [${m.category}]` : '';
      blocks.push(`- ${m.summary.slice(0, 300)}${category}${score}`);
    });
  }

  // ── Memórias de alto peso emocional ──────────────────────────────────────
  // Apenas as que não foram incluídas no bloco acima
  const semanticIds = new Set(memories.map(m => m.id));
  const uniqueEmotional = topEmotional.filter(m => !semanticIds.has(m.id));

  if (uniqueEmotional.length > 0) {
    blocks.push('\nExperiências de alto peso emocional (sempre presentes):');
    uniqueEmotional.forEach(m => {
      const weight = ` [peso emocional: ${Math.round(m.emotional_weight * 100)}%]`;
      blocks.push(`- ${m.summary.slice(0, 300)}${weight}`);
    });
  }

  // Instrução de uso para o LLM
  blocks.push(
    '\nUse essas memórias para contextualizar respostas, reconhecer padrões ' +
    'e conectar o que o usuário trouxe agora ao que viveu antes. ' +
    'Não cite as memórias diretamente — integre-as naturalmente.'
  );

  return blocks.join('\n');
}
