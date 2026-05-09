// lib/tools/executors/debriefing.ts
// Domínio: Aprendizado — Job Diário de Debriefing
//
// Fluxo:
//   1. Busca execution_logs das últimas 24h sem debriefing
//   2. Envia para o LLM extrair insights por usuário
//   3. Salva em learned_insights (source_type: 'inferred')
//   4. Reforça confidence_score de insights similares já existentes
//   5. Marca os logs como processados
//
// Este arquivo é chamado apenas pela rota /api/debriefing/run.
// Nunca exposto como tool ao modelo.

import { supabase } from '@/lib/jarvis';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEBRIEFING_MODEL   = 'anthropic/claude-sonnet-4-5';

// Teto máximo para insights inferred — só user_confirmed/user_corrected podem passar disso
const MAX_INFERRED_CONFIDENCE = 0.75;

// Quanto o score sobe a cada reforço
const CONFIDENCE_INCREMENT = 0.1;

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface ExecutionLog {
  id: string;
  user_id: number;
  tool_name: string;
  arguments: Record<string, any>;
  output: string;
  user_feedback_received: boolean;
  user_feedback_text: string | null;
  context_snapshot: Record<string, any>[] | null;
  created_at: string;
}

interface LearnedInsight {
  user_id: number;
  insight_text: string;
  source_type: 'inferred';
  source_log_id: string;
  confidence_score: number;
}

interface ExistingInsight {
  id: string;
  insight_text: string;
  confidence_score: number;
  source_type: string;
}

interface DebriefingSummary {
  logsProcessed: number;
  insightsSaved: number;
  insightsReinforced: number;
  userIds: number[];
}

// ─── Similaridade textual simples (sem pgvector) ──────────────────────────────
// Tokeniza em palavras, calcula interseção / união (Jaccard).
// Threshold 0.35 captura padrões como:
//   "prefere treino em dias úteis" ≈ "lembretes de treino apenas dias úteis"

function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean));

  const setA = tokenize(a);
  const setB = tokenize(b);

  const intersection = new Set([...setA].filter(t => setB.has(t)));
  const union        = new Set([...setA, ...setB]);

  return union.size === 0 ? 0 : intersection.size / union.size;
}

const SIMILARITY_THRESHOLD = 0.35;

// ─── LLM: extrai insights de um lote de logs ─────────────────────────────────

async function extractInsightsFromLogs(
  logs: ExecutionLog[]
): Promise<{ insight: string; logId: string; confidence: number }[]> {
  const logsForPrompt = logs.map(l => ({
    id:       l.id,
    tool:     l.tool_name,
    args:     l.arguments,
    output:   l.output,
    feedback: l.user_feedback_text ?? null,
    context:  l.context_snapshot?.map((m: any) => `${m.role}: ${m.content}`).join('\n') ?? null,
  }));

  const prompt = `
Você é um analista de comportamento de assistentes pessoais.
Analise os logs de execução abaixo e extraia insights sobre preferências, padrões e correções do usuário.

Regras:
- Só extraia insights concretos e acionáveis (ex: "Usuário prefere lembretes de treino apenas em dias úteis")
- Se houver feedback explícito do usuário (campo "feedback"), priorize — confidence 0.8
- Se for um padrão inferido sem feedback, confidence 0.3
- Ignore logs de consulta pura (buscar_memoria_longa, consultar_agenda, etc.) a menos que haja correção
- Retorne APENAS JSON válido, sem texto extra

Formato de retorno:
[
  { "insight": "texto do insight", "logId": "uuid do log de origem", "confidence": 0.0 }
]

Logs:
${JSON.stringify(logsForPrompt, null, 2)}
`.trim();

  const res = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model:      DEBRIEFING_MODEL,
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`[Debriefing] LLM error: ${res.status}`);

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content ?? '[]';

  try {
    return JSON.parse(raw);
  } catch {
    console.error('[Debriefing] LLM retornou JSON inválido:', raw);
    return [];
  }
}

// ─── Reforça insights existentes similares ────────────────────────────────────

async function reinforceExistingInsights(
  userId: number,
  newInsightTexts: string[]
): Promise<number> {
  if (!newInsightTexts.length) return 0;

  const { data: existing, error } = await supabase
    .schema('jarvis')
    .from('learned_insights')
    .select('id, insight_text, confidence_score, source_type')
    .eq('user_id', userId)
    .eq('is_active', true);

  if (error || !existing?.length) return 0;

  const toReinforce: { id: string; newScore: number }[] = [];

  for (const existingInsight of existing as ExistingInsight[]) {
    // Insights corrigidos pelo usuário não sofrem alteração automática
    if (existingInsight.source_type === 'user_corrected') continue;

    const isSimilar = newInsightTexts.some(
      newText => jaccardSimilarity(existingInsight.insight_text, newText) >= SIMILARITY_THRESHOLD
    );

    if (!isSimilar) continue;

    const currentScore = existingInsight.confidence_score;
    const cap = existingInsight.source_type === 'inferred'
      ? MAX_INFERRED_CONFIDENCE
      : 1.0;

    const newScore = Math.min(currentScore + CONFIDENCE_INCREMENT, cap);

    if (newScore > currentScore) {
      toReinforce.push({ id: existingInsight.id, newScore });
    }
  }

  if (!toReinforce.length) return 0;

  await Promise.all(
    toReinforce.map(({ id, newScore }) =>
      supabase
        .schema('jarvis')
        .from('learned_insights')
        .update({
          confidence_score:  newScore,
          last_validated_at: new Date().toISOString(),
        })
        .eq('id', id)
    )
  );

  return toReinforce.length;
}

// ─── Salva insights novos ─────────────────────────────────────────────────────

async function saveInsights(insights: LearnedInsight[]): Promise<number> {
  if (!insights.length) return 0;

  const { error } = await supabase
    .schema('jarvis')
    .from('learned_insights')
    .insert(insights);

  if (error) {
    console.error('[Debriefing] Erro ao salvar insights:', error);
    return 0;
  }

  return insights.length;
}

// ─── Marca logs como processados ─────────────────────────────────────────────

async function markLogsAsProcessed(logIds: string[]): Promise<void> {
  if (!logIds.length) return;

  const { error } = await supabase
    .schema('jarvis')
    .from('execution_logs')
    .update({ debriefed_at: new Date().toISOString() })
    .in('id', logIds);

  if (error) console.error('[Debriefing] Erro ao marcar logs:', error);
}

// ─── Entrypoint público ───────────────────────────────────────────────────────

export async function runDebriefing(): Promise<DebriefingSummary> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: logs, error } = await supabase
    .schema('jarvis')
    .from('execution_logs')
    .select('*')
    .gte('created_at', since)
    .is('debriefed_at', null)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`[Debriefing] Erro ao buscar logs: ${error.message}`);
  if (!logs?.length) return { logsProcessed: 0, insightsSaved: 0, insightsReinforced: 0, userIds: [] };

  const byUser = (logs as ExecutionLog[]).reduce<Record<number, ExecutionLog[]>>((acc, log) => {
    if (!acc[log.user_id]) acc[log.user_id] = [];
    acc[log.user_id].push(log);
    return acc;
  }, {});

  let totalInsights   = 0;
  let totalReinforced = 0;
  const userIds       = Object.keys(byUser).map(Number);

  for (const userId of userIds) {
    const userLogs = byUser[userId];

    const extracted = await extractInsightsFromLogs(userLogs);

    const insights: LearnedInsight[] = extracted.map(e => ({
      user_id:          userId,
      insight_text:     e.insight,
      source_type:      'inferred',
      source_log_id:    e.logId,
      confidence_score: e.confidence,
    }));

    const saved      = await saveInsights(insights);
    totalInsights   += saved;

    const newTexts   = insights.map(i => i.insight_text);
    const reinforced = await reinforceExistingInsights(userId, newTexts);
    totalReinforced += reinforced;

    await markLogsAsProcessed(userLogs.map(l => l.id));
  }

  return {
    logsProcessed:      logs.length,
    insightsSaved:      totalInsights,
    insightsReinforced: totalReinforced,
    userIds,
  };
}