// lib/tools/executors/decay.ts
// Domínio: Aprendizado — Job Semanal de Decaimento
//
// Fluxo:
//   1. Busca insights ativos não validados há 30+ dias
//   2. Reduz confidence_score por source_type
//   3. Desativa insights que chegam abaixo do score mínimo
//
// Regras:
//   - user_corrected → intocável
//   - user_confirmed → decai -0.05 por rodada
//   - inferred       → decai -0.10 por rodada
//   - score < 0.1    → is_active = false
//
// Chamado apenas pela rota /api/debriefing/decay.
// Nunca exposto como tool ao modelo.

import { supabase } from '@/lib/jarvis';

// ─── Constantes ───────────────────────────────────────────────────────────────

const DECAY_THRESHOLD_DAYS  = 30;   // dias sem validação para começar a decair
const DECAY_INFERRED        = 0.10;
const DECAY_CONFIRMED       = 0.05;
const MIN_SCORE_BEFORE_DEACTIVATION = 0.10;

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface InsightToDecay {
  id: string;
  source_type: string;
  confidence_score: number;
}

export interface DecaySummary {
  insightsDecayed: number;
  insightsDeactivated: number;
}

// ─── Entrypoint público ───────────────────────────────────────────────────────

export async function runDecay(): Promise<DecaySummary> {
  const cutoff = new Date(
    Date.now() - DECAY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  // Busca insights ativos, não corrigidos, sem validação recente
  const { data: insights, error } = await supabase
    .schema('jarvis')
    .from('learned_insights')
    .select('id, source_type, confidence_score')
    .eq('is_active', true)
    .neq('source_type', 'user_corrected')
    .or(`last_validated_at.is.null,last_validated_at.lte.${cutoff}`);

  if (error) throw new Error(`[Decay] Erro ao buscar insights: ${error.message}`);
  if (!insights?.length) return { insightsDecayed: 0, insightsDeactivated: 0 };

  const toDeactivate: string[] = [];
  const toDecay: { id: string; newScore: number }[] = [];

  for (const insight of insights as InsightToDecay[]) {
    const decrement = insight.source_type === 'user_confirmed'
      ? DECAY_CONFIRMED
      : DECAY_INFERRED;

    const newScore = Math.max(0, insight.confidence_score - decrement);

    if (newScore < MIN_SCORE_BEFORE_DEACTIVATION) {
      toDeactivate.push(insight.id);
    } else {
      toDecay.push({ id: insight.id, newScore });
    }
  }

  // Desativa insights esgotados
  if (toDeactivate.length) {
    const { error: deactivateError } = await supabase
      .schema('jarvis')
      .from('learned_insights')
      .update({ is_active: false })
      .in('id', toDeactivate);

    if (deactivateError) console.error('[Decay] Erro ao desativar:', deactivateError);
  }

  // Reduz score dos demais
  if (toDecay.length) {
    await Promise.all(
      toDecay.map(({ id, newScore }) =>
        supabase
          .schema('jarvis')
          .from('learned_insights')
          .update({ confidence_score: newScore })
          .eq('id', id)
      )
    );
  }

  return {
    insightsDecayed:     toDecay.length,
    insightsDeactivated: toDeactivate.length,
  };
}