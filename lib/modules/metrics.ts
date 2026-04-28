import { supabase } from '@/lib/jarvis';

export async function recordModuleMetrics(
  moduleId: string,
  userId: string,
  data: { latencyMs: number; tokens: number; activated: boolean }
) {
  await supabase.schema('jarvis').from('module_metrics').insert({
    module_id: moduleId,
    user_id: userId,
    latency_ms: data.latencyMs,
    tokens_estimated: data.tokens,
    activated: data.activated,
    recorded_at: new Date().toISOString(),
  });
}

// Lê resumo de custo/latência por módulo (para dashboard ou debug)
export async function getModuleMetricsSummary(userId: string) {
  const { data } = await supabase
    .schema('jarvis')
    .from('module_metrics')
    .select('module_id, latency_ms, tokens_estimated, activated, recorded_at')
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
    grouped[row.module_id].totalLatency += row.latency_ms;
    grouped[row.module_id].totalTokens += row.tokens_estimated;
    if (row.activated) grouped[row.module_id].activations++;
  }

  return Object.entries(grouped).map(([id, v]: any) => ({
    module_id: id,
    avg_latency_ms: Math.round(v.totalLatency / v.count),
    avg_tokens: Math.round(v.totalTokens / v.count),
    activation_rate: Math.round((v.activations / v.count) * 100),
    calls_7d: v.count,
  }));
}
