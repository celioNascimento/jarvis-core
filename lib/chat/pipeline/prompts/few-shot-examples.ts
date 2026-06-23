// lib/chat/pipeline/prompts/few-shot-examples.ts

import { supabase, generateEmbedding } from '@/lib/jarvis';

interface FewShotExample {
  user_message:       string;
  assistant_response: string;
  emotional_state:    string;
  similarity:         number;
}

// 0.6 é mais seguro que 0.7 como ponto de partida —
// ajuste pra cima se exemplos ruins estiverem entrando,
// pra baixo se nenhum estiver passando.
const SIMILARITY_MINIMA = 0.6;

export async function buildFewShotExamplesPrompt(
  mensagemUsuario: string,
  embeddingPreComputado?: number[] | null, // reutiliza se já foi gerado pelo pipeline
): Promise<string> {
  let embedding = embeddingPreComputado ?? null;

  if (!embedding) {
    embedding = await generateEmbedding(mensagemUsuario);
  }

  if (!embedding) return '';

  const { data, error } = await supabase.rpc('match_few_shot_examples', {
    query_embedding: embedding,
    match_count:     3,
  });

  if (error) {
    console.warn('[FewShot] Erro ao buscar exemplos:', error.message);
    return '';
  }

  const candidatos = (data ?? []) as FewShotExample[];
  const aprovados  = candidatos.filter((ex) => ex.similarity > SIMILARITY_MINIMA);

  // Log essencial: confirma se o sistema está encontrando exemplos relevantes
  console.log(
    `[FewShot] ${candidatos.length} candidatos | ${aprovados.length} aprovados (threshold: ${SIMILARITY_MINIMA})`,
    aprovados.map((ex) => ({ estado: ex.emotional_state, sim: ex.similarity.toFixed(3) })),
  );

  if (!aprovados.length) return '';

  const exemplos = aprovados
    .map((ex) => `Usuário: ${ex.user_message}\nLev: ${ex.assistant_response}`)
    .join('\n\n---\n\n');

  return `## REFERÊNCIA DE TOM — Situações parecidas que o Lev já viveu:\n\n${exemplos}\n\n(Use como referência de abordagem e tom emocional. Não copie literalmente — adapte ao contexto atual.)`;
}