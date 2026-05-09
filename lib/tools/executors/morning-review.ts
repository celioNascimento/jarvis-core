// lib/tools/executors/morning-review.ts
// Domínio: Aprendizado — Job Diário de Revisão Matinal
//
// Fluxo:
//   1. Busca até 3 insights inferred recentes por usuário
//   2. Envia um push por insight via Expo Push API
//      com data.type = 'insight_review' para o app renderizar botões
//   3. O app responde via /api/debriefing/validate
//
// Chamado apenas pela rota /api/debriefing/morning-review.
// Nunca exposto como tool ao modelo.

import { supabase } from '@/lib/jarvis';

const EXPO_PUSH_URL = 'https://exp.host/--/exponent-push-notifications/v2/push/send';
const MAX_INSIGHTS_PER_USER = 3;

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface InsightToReview {
  id: string;
  insight_text: string;
  confidence_score: number;
}

export interface MorningReviewSummary {
  usersNotified: number;
  pushSent: number;
}

// ─── Envia push via Expo ──────────────────────────────────────────────────────

async function sendInsightReviewPush(
  expoPushToken: string,
  insight: InsightToReview
): Promise<boolean> {
  const payload = {
    to:    expoPushToken,
    title: '🧠 Aprendi algo sobre você',
    body:  insight.insight_text,
    sound: 'default',
    data:  {
      type:       'insight_review',   // o app detecta esse type e renderiza botões
      insightId:  insight.id,
      insightText: insight.insight_text,
    },
    priority: 'high',
  };

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const result = await res.json();
    const ticket = result.data;

    if (ticket?.status === 'error') {
      console.error(`[MorningReview] Expo push error para insight ${insight.id}:`, ticket.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[MorningReview] Exceção no envio push:', err);
    return false;
  }
}

// ─── Entrypoint público ───────────────────────────────────────────────────────

export async function runMorningReview(): Promise<MorningReviewSummary> {
  // 1. Busca todos os usuários com push_token e insights inferred pendentes
  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('id, push_token')
    .not('push_token', 'is', null);

  if (usersError || !users?.length) return { usersNotified: 0, pushSent: 0 };

  let totalPushSent   = 0;
  let totalUsers      = 0;

  for (const user of users) {
    // 2. Busca até 3 insights inferred recentes desse usuário
    const { data: insights, error: insightsError } = await supabase
      .schema('jarvis')
      .from('learned_insights')
      .select('id, insight_text, confidence_score')
      .eq('user_id', user.id)
      .eq('source_type', 'inferred')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(MAX_INSIGHTS_PER_USER);

    if (insightsError || !insights?.length) continue;

    // 3. Envia um push por insight
    let sent = 0;
    for (const insight of insights as InsightToReview[]) {
      const ok = await sendInsightReviewPush(user.push_token, insight);
      if (ok) sent++;
    }

    if (sent > 0) {
      totalPushSent += sent;
      totalUsers++;
    }
  }

  return { usersNotified: totalUsers, pushSent: totalPushSent };
}