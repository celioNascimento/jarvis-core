// lib/chat/  .ts
import { getCachedPersons } from './persons-cache';
import { getRecentMoodAdjustment } from './diary';

const EMOTIONAL_MARKERS = /sinto|triste|ansioso|medo|preocup|cansado|sozinho|saudade|perdi|difícil|tá pesado|deprimido|angustiado|desesperado|chateado|aborrecido|magoado/i;

export interface EmotionalScoreResult {
  score: number;
  trajectory: string;
  primaryEmotion: string;   
  triggers: string[];
  memoryScore: number;
  personScore: number;
  moodAdjustment: number;
  escalatingCount: number;
}

/**
 * Calcula o score emocional baseado em:
 * - memórias ativadas (similarity * emotional_weight)
 * - pessoas mencionadas (emotional_weight)
 * - trajetória emocional nas últimas 6 linhas da RAM
 * - humor recente do diário (cacheado)
 */
export async function computeEmotionalScore(
  messageText: string,
  userId: string,
  hdSearchResults: Array<{ similarity: number; emotional_weight: number; summary?: string }>,
  ramBlock: string,
): Promise<EmotionalScoreResult> {
  const triggers: string[] = [];

  // 1. Memory score
  let memoryScore = 0;
  if (hdSearchResults.length > 0) {
    const weightedSum = hdSearchResults.reduce(
      (acc, r) => acc + (r.similarity * (r.emotional_weight ?? 0.5)),
      0
    );
    memoryScore = weightedSum / hdSearchResults.length;
    memoryScore = Math.min(1, Math.max(0, memoryScore));

    if (memoryScore > 0.5 && hdSearchResults[0]?.summary) {
      const snippet = hdSearchResults[0].summary.slice(0, 50).replace(/\n/g, ' ');
      triggers.push(`memória:${snippet}...`);
    }
  }

  // 2. Person score
  let personScore = 0;
  let highWeightPerson: string | null = null;
  try {
    const persons = await getCachedPersons(userId);
    for (const p of persons) {
      const nameRegex = new RegExp(`\\b${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (nameRegex.test(messageText)) {
        const weight = p.emotional_weight ?? 0.5;
        if (weight > personScore) {
          personScore = weight;
          highWeightPerson = p.name;
        }
      }
    }
    personScore = Math.min(1, Math.max(0, personScore));

    if (highWeightPerson && personScore > 0.7) {
      triggers.push(`pessoa:${highWeightPerson}`);
    }
  } catch (err) {
    console.warn('[EmotionalRouter] Erro ao buscar persons:', err);
  }

  // 3. Trajectory from RAM
  const ramLines = ramBlock.split('\n').slice(-6);
  const escalatingCount = ramLines.filter(line => EMOTIONAL_MARKERS.test(line)).length;
  const trajectory = escalatingCount >= 2 ? 'escalating' : 'stable';
  if (trajectory === 'escalating') triggers.push('trajetória_emocional:escalando');

  // 4. Mood adjustment (cacheado)
  let moodAdjustment = 0;
  try {
    moodAdjustment = await getRecentMoodAdjustment(userId);
    if (moodAdjustment > 0.05) triggers.push(`humor_recente:${moodAdjustment.toFixed(2)}`);
  } catch (err) {
    console.warn('[EmotionalRouter] Erro ao obter mood:', err);
  }

  // Score final ponderado
  const WEIGHTS = {
    memory: 0.35,
    person: 0.30,
    trajectory: 0.20,
    mood: 0.15,
  };
  const trajectoryScore = Math.min(1, escalatingCount / 6);
  const baseScore =
    (memoryScore * WEIGHTS.memory) +
    (personScore * WEIGHTS.person) +
    (trajectoryScore * WEIGHTS.trajectory) +
    (moodAdjustment * WEIGHTS.mood);

  const finalScore = Math.min(1, Math.max(0, baseScore));

  return {
    score: finalScore,
    trajectory,
    primaryEmotion: finalScore > 0.6 ? 'alerta' : 'neutral', // Adicione esta linha
    triggers,
    memoryScore,
    personScore,
    moodAdjustment,
    escalatingCount,
  };
}