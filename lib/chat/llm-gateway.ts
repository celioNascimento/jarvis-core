// lib/chat/llm-gateway.ts
// V11.2.0 — fix toolCalls preservation + log de diagnóstico

import { Redis } from '@upstash/redis';
import { callOpenRouterWithTools as rawCallOpenRouter } from '@/lib/chat/openrouter';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const FALLBACK_MODEL = 'google/gemini-2.0-flash';
const CONCURRENCY_LIMIT = 3;

let localBreaker = { open: false, expires: 0 };

function edgeSafeHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

class Gatekeeper {
  async isOverloaded(): Promise<boolean> {
    try {
      const count = await redis.get<number>('global_llm_active');
      return (count ?? 0) >= CONCURRENCY_LIMIT;
    } catch {
      return false;
    }
  }

  async enqueue(task: any): Promise<any> {
    const dedupKey = `llm_dedup:${task.id}:${edgeSafeHash(task.dedupPayload || '')}`;

    const [cached, activeCount] = await redis.pipeline()
      .get(dedupKey)
      .incr('global_llm_active')
      .exec();

    if (cached) {
      await redis.decr('global_llm_active');
      // ── toolCalls pode ter sido serializado como null no Redis
      //    Garante que o shape está correto ao retornar do cache
      const hit = cached as any;
      return {
        ...hit,
        toolCalls: hit.toolCalls ?? null,
      };
    }

    try {
      const currentLoad = activeCount as number;
      const isOverloaded = currentLoad > CONCURRENCY_LIMIT;

      if (isOverloaded) {
        if (task.priority === 1) {
          await this.waitSmartly(4000);
        } else if (task.params.model !== FALLBACK_MODEL) {
          console.warn(`[Gateway] Downgrade preventivo (Load: ${currentLoad}).`);
          task.params.model = FALLBACK_MODEL;
        }
      }

      return await this.executeWithFallback(task, dedupKey);
    } finally {
      await redis.decr('global_llm_active').catch(() => {});
    }
  }

  private async waitSmartly(ms: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const count = await redis.get<number>('global_llm_active').catch(() => 99);
      if ((count || 0) <= CONCURRENCY_LIMIT) return;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  private async executeWithFallback(task: any, dk: string): Promise<any> {
    const originalModel = task.params.model;

    if (localBreaker.open && Date.now() > localBreaker.expires) localBreaker.open = false;

    if (!localBreaker.open && originalModel !== FALLBACK_MODEL) {
      const globalBreaker = await redis.get('llm_circuit_breaker').catch(() => null);
      if (globalBreaker === 'open') {
        localBreaker = { open: true, expires: Date.now() + 30000 };
      }
    }

    if (localBreaker.open && originalModel !== FALLBACK_MODEL) task.params.model = FALLBACK_MODEL;

    try {
      const isPro = task.params.model !== FALLBACK_MODEL;
      const timeout = isPro ? 10000 : 25000;

      const res = await rawCallOpenRouter(
        task.params.messages,
        task.params.tools,
        task.params.model,
        task.params.temperature,
        timeout,
        task.params.maxTokens,
        task.params.toolChoice
      );

      // ── Diagnóstico: loga quando tools foram enviadas mas não chamadas
      if (task.params.tools?.length > 0 && !res.toolCalls?.length) {
        console.warn(
          `[Gateway] LLM retornou texto puro — tools enviadas: ${task.params.tools.map((t: any) => t.function?.name).join(', ')}`
        );
      }

      const enriched = { ...res, modelUsed: task.params.model };

      // ── Só cacheia se NÃO houve tool_calls — resposta com tool calls
      //    não deve ser reutilizada (cada execução é única)
      if (!res.toolCalls?.length) {
        await redis.set(dk, enriched, { ex: 20 }).catch(() => {});
      }

      return enriched;

    } catch (error: any) {
      if (task.params.model !== FALLBACK_MODEL && (error?.status === 429 || error?.message?.includes('timeout'))) {
        await redis.set('llm_circuit_breaker', 'open', { ex: 60 });
        return await rawCallOpenRouter(
          task.params.messages,
          task.params.tools,
          FALLBACK_MODEL,
          task.params.temperature,
          20000
        );
      }
      throw error;
    }
  }
}

export const llmGateway = new Gatekeeper();

export async function callOpenRouterWithPriority(
  priority: 1|2|3|4,
  dropPolicy: string,
  taskId: string,
  messages: any[],
  tools: any[],
  model: string,
  temperature: number,
  timeoutMs: number = 25000,
  maxTokens?: number,
  toolChoice?: any
): Promise<any> {
  return llmGateway.enqueue({
    id: taskId,
    priority,
    params: { messages, tools, model, temperature, timeoutMs, maxTokens, toolChoice },
    dedupPayload: JSON.stringify({ messages, model, tools }),
  });
}