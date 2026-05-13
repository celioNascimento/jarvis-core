// lib/chat/llm-gateway.ts
import { Redis } from '@upstash/redis';
import { callOpenRouterWithTools as rawCallOpenRouter } from '@/lib/chat/openrouter';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const FALLBACK_MODEL = 'google/gemini-2.5-flash';
let localModelBan: { [model: string]: number } = {};

function edgeSafeHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

class Gatekeeper {
  async isOverloaded(): Promise<boolean> {
    const count = await redis.get<number>('global_llm_active').catch(() => 0);
    return (count || 0) >= 3;
  }

  async enqueue(task: any): Promise<any> {
    const dk = `llm_dedup:${task.id}:${edgeSafeHash(task.dedupPayload || '')}`;
    const cached = await redis.get(dk).catch(() => null);
    if (cached) return cached;

    const executionId = `${task.id}:${Date.now()}`;
    await redis.zadd('llm_task_queue_sorted', { score: task.priority * 1e13 + Date.now(), member: executionId });

    try {
      let myTurn = false;
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const [next] = await redis.zrange('llm_task_queue_sorted', 0, 0);
        if (next === executionId) {
          const count = await redis.incr('global_llm_active');
          if (count <= 3) {
            await redis.zrem('llm_task_queue_sorted', executionId);
            myTurn = true; break;
          }
          await redis.decr('global_llm_active');
        }
        await new Promise(r => setTimeout(r, 250));
      }
      if (!myTurn) throw new Error('GATEKEEPER_TIMEOUT');

      return await this.executeWithFallback(task, dk);
    } finally {
      await redis.decr('global_llm_active').catch(() => {});
      await redis.zrem('llm_task_queue_sorted', executionId).catch(() => {});
    }
  }

  private async executeWithFallback(task: any, dk: string): Promise<any> {
    const originalModel = task.params.model;
    const isBanned = localModelBan[originalModel] && Date.now() < localModelBan[originalModel];
    
    if (originalModel !== FALLBACK_MODEL && (isBanned || (await redis.get('llm_circuit_breaker')) === 'open')) {
      task.params.model = FALLBACK_MODEL;
    }

    try {
      const timeout = task.params.model === FALLBACK_MODEL ? task.params.timeoutMs : 6000;
      const res = await rawCallOpenRouter(task.params.messages, task.params.tools, task.params.model, task.params.temperature, timeout, task.params.maxTokens, task.params.toolChoice);
      const enriched = typeof res === 'object' ? { ...res, modelUsed: task.params.model } : res;
      if (res) await redis.set(dk, enriched, { ex: 15 }).catch(() => {});
      return enriched;
    } catch (error: any) {
      if ((error?.status === 429 || error?.message?.includes('429')) && task.params.model !== FALLBACK_MODEL) {
        localModelBan[originalModel] = Date.now() + 300000;
        await redis.set('llm_circuit_breaker', 'open', { ex: 60 });
        task.params.model = FALLBACK_MODEL;
        // Resgate direto via Flash
        return rawCallOpenRouter(task.params.messages, task.params.tools, FALLBACK_MODEL, task.params.temperature, 20000);
      }
      throw error;
    }
  }
}

export const llmGateway = new Gatekeeper();

export async function callOpenRouterWithPriority(
  priority: 1|2|3|4, dropPolicy: string, taskId: string, messages: any[], tools: any[], model: string, temperature: number, 
  timeoutMs: number = 25000, maxTokens?: number, toolChoice?: any
): Promise<any> {
  return llmGateway.enqueue({
    id: taskId, priority, dropPolicy,
    params: { messages, tools, model, temperature, timeoutMs, maxTokens, toolChoice },
    dedupPayload: JSON.stringify({ messages, model, tools })
  });
}
