import { supabase } from '@/lib/jarvis';

// ── Insert individual (compatibilidade com chamadas existentes) ───────────────

export async function recordModuleMetrics(
  moduleId: string,
  userId: number,
  payload: { latencyMs: number; tokens: number; activated: boolean }
): Promise<void> {
  return recordModuleMetricsBatch(userId, [{
    moduleId,
    latencyMs: payload.latencyMs,
    tokens:    payload.tokens,
    activated: payload.activated,
  }]);
}

// ── Batch insert — use este quando tiver múltiplos módulos ───────────────────

export async function recordModuleMetricsBatch(
  userId: number,
  metrics: Array<{
    moduleId:  string;
    latencyMs: number;
    tokens:    number;
    activated: boolean;
  }>
): Promise<void> {
  if (!metrics.length) return;

  try {
    const { error } = await supabase
      .schema('jarvis')
      .from('module_metrics')
      .insert(
        metrics.map(m => ({
          module_id:        m.moduleId,
          user_id:          userId,
          latency_ms:       m.latencyMs,
          tokens_estimated: m.tokens,
          activated:        m.activated,
        }))
      );

    if (error) {
      console.error('[Metrics] Falha no batch insert:', error.message || error);
    }
  } catch (e: any) {
    console.error('[Metrics] Falha de rede no batch:', e);
  }
}

// ── Resumo por módulo (dashboard/debug) ──────────────────────────────────────

export async function getModuleMetricsSummary(userId: string) {
  const { data } = await supabase
    .schema('jarvis')
    .from('module_metrics')
    .select('module_id, execution_time_ms, tokens_used, activated, recorded_at')
    .eq('user_id', userId)
    .gte('recorded_at', new Date(Date.now() - 7 * 86400000).toISOString())
    .order('recorded_at', { ascending: false });

  if (!data?.length) return [];

  const grouped: Record<string, any> = {};
  for (const row of data) {
    if (!grouped[row.module_id]) {
      grouped[row.module_id] = { count: 0, totalLatency: 0, totalTokens: 0, activations: 0 };
    }
    grouped[row.module_id].count++;
    grouped[row.module_id].totalLatency += row.execution_time_ms;
    grouped[row.module_id].totalTokens  += row.tokens_used;
    if (row.activated) grouped[row.module_id].activations++;
  }

  return Object.entries(grouped).map(([id, v]: any) => ({
    module_id:       id,
    avg_latency_ms:  Math.round(v.totalLatency / v.count),
    avg_tokens:      Math.round(v.totalTokens / v.count),
    activation_rate: Math.round((v.activations / v.count) * 100),
    calls_7d:        v.count,
  }));
}