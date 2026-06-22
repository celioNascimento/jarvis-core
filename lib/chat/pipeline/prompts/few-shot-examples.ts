// lib/chat/pipeline/prompts/few-shot-examples.ts
// Busca exemplos reais de como o Lev respondeu em situações emocionalmente
// parecidas e os injeta como referência de tom no system prompt.
//
// Usa o cliente central (lib/jarvis.ts):
// - supabase: já aponta pro schema jarvis, sem .schema() necessário
// - generateEmbedding: usa OpenRouter, retorna null em falha (nunca lança)

import { supabase, generateEmbedding } from '@/lib/jarvis';

interface FewShotExample {
  user_message:       string;
  assistant_response: string;
  emotional_state:    string;
  similarity:         number;
}

// Corte mínimo de similaridade coseno (0–1).
// Abaixo disso, o exemplo não é parecido o suficiente e é descartado.
// 0.7 é conservador — ajuste pra baixo se poucos exemplos estiverem sendo retornados.
const SIMILARITY_MINIMA = 0.7;

export async function buildFewShotExamplesPrompt(mensagemUsuario: string): Promise<string> {
  const embedding = await generateEmbedding(mensagemUsuario);
  if (!embedding) return ''; // generateEmbedding já logou o erro internamente

  const { data, error } = await supabase.rpc('match_few_shot_examples', {
    query_embedding: embedding,
    match_count:     3,
  });

  if (error) {
    console.warn('[FewShot] Erro ao buscar exemplos:', error.message);
    return '';
  }

  const exemplos = ((data ?? []) as FewShotExample[])
    .filter((ex) => ex.similarity > SIMILARITY_MINIMA)
    .map((ex) => `Usuário: ${ex.user_message}\nLev: ${ex.assistant_response}`)
    .join('\n\n---\n\n');

  if (!exemplos) return '';

  return `## REFERÊNCIA DE TOM — Situações parecidas que o Lev já viveu:\n\n${exemplos}\n\n(Use como referência de abordagem e tom emocional. Não copie literalmente — adapte ao contexto atual.)`;
}