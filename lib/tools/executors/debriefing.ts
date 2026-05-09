// lib/tools/executors/debriefing.ts
// Domínio: Aprendizado — Job Diário de Debriefing
//
// Fluxo:
//   1. Busca execution_logs das últimas 24h sem debriefing
//   2. Envia para o LLM extrair insights por usuário
//   3. Salva em learned_insights (source_type: 'inferred')
//   4. Marca os logs como processados
//
// Este arquivo é chamado apenas pela rota /api/debriefing/run.
// Nunca exposto como tool ao modelo.

import { supabase } from '@/lib/jarvis';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEBRIEFING_MODEL   = 'anthropic/claude-sonnet-4-5'; // modelo de análise, não de chat

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

interface DebriefingSummary {
  logsProcessed: number;
  insightsSaved: number;
  userIds: number[];
}

// ─── LLM: extrai insights de um lote de logs ─────────────────────────────────

async function extractInsightsFromLogs(
  logs: ExecutionLog[]
): Promise<{ insight: string; logId: string; confidence: number }[]> {
  const logsForPrompt = logs.map(l => ({
    id:         l.id,
    tool:       l.tool_name,
    args:       l.arguments,
    output:     l.output,
    feedback:   l.user_feedback_text ?? null,
    context:    l.context_snapshot?.map((m: any) => `${m.role}: ${m.content}`).join('\n') ?? null,
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

// ─── Salva insights no banco ──────────────────────────────────────────────────

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
  // 1. Busca logs das últimas 24h ainda não processados
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: logs, error } = await supabase
    .schema('jarvis')
    .from('execution_logs')
    .select('*')
    .gte('created_at', since)
    .is('debriefed_at', null)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`[Debriefing] Erro ao buscar logs: ${error.message}`);
  if (!logs?.length) return { logsProcessed: 0, insightsSaved: 0, userIds: [] };

  // 2. Agrupa por usuário
  const byUser = (logs as ExecutionLog[]).reduce<Record<number, ExecutionLog[]>>((acc, log) => {
    if (!acc[log.user_id]) acc[log.user_id] = [];
    acc[log.user_id].push(log);
    return acc;
  }, {});

  let totalInsights = 0;
  const userIds = Object.keys(byUser).map(Number);

  // 3. Processa cada usuário separadamente
  for (const userId of userIds) {
    const userLogs = byUser[userId];

    const extracted = await extractInsightsFromLogs(userLogs);

    const insights: LearnedInsight[] = extracted.map(e => ({
      user_id:        userId,
      insight_text:   e.insight,
      source_type:    'inferred',
      source_log_id:  e.logId,
      confidence_score: e.confidence,
    }));

    const saved = await saveInsights(insights);
    totalInsights += saved;

    // 4. Marca os logs deste usuário como processados
    await markLogsAsProcessed(userLogs.map(l => l.id));
  }

  return {
    logsProcessed: logs.length,
    insightsSaved: totalInsights,
    userIds,
  };
}