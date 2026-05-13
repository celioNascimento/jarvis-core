// lib/chat/llm-gateway.ts
// Motor V10.2.1 — Fast-Track Edition (Build Fixed)
// Fila, Semáforo e Banimento Local de modelos instáveis.

import { Redis } from '@upstash/redis';
import { callOpenRouterWithTools as rawCallOpenRouter } from '@/lib/chat/openrouter';
import { createHash } from 'crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const FALLBACK_MODEL = 'google/gemini-2.5-flash';
const BAN_TIME_MS = 5 * 60 * 1000; 

let localModelBan: { [model: string]: number } = {};

export type PriorityLevel = 1 | 2 | 3 | 4;
export type DropPolicy    = 'never' | 'if_full';

export interface LLMTask {
  id:               string; 
  priority:         PriorityLevel;
  dropPolicy:       DropPolicy;
  openRouterParams: {
    messages:    any[];
    tools:       any[];
    model:       string;
    temperature: number;
    timeoutMs:   number;
    maxTokens?:  number;
    toolChoice?: any;
  };
  dedupPayload?:    string;
}

const MAX_CONCURRENT   = 3;
const ACTIVE_KEY       = 'global_llm_active';
const BREAKER_KEY      = 'llm_circuit_breaker';
const QUEUE_POLL_MS    = 250;
const WAITER_TIMEOUT_S = 45; 

class Gatekeeper {
  
  private async isBreakerOpen(model: string): Promise<boolean> {
    if (localModelBan[model] && Date.now() < localModelBan[model]) return true;
    try { return (await redis.get(BREAKER_KEY)) === 'open'; }
    catch { return false; }
  }

  private banModel(model: string) {
    console.warn(`[Gatekeeper] Banindo ${model} localmente.`);
    localModelBan[model] = Date.now() + BAN_TIME_MS;
  }

  async enqueue(task: LLMTask): Promise<any> {
    const dk = `llm_dedup:${task.id}:${createHash('sha256').update(task.dedupPayload || '').digest('hex').slice(0, 10)}`;

    const cached = await redis.get(dk).catch(() => null);
    if (cached) return cached;

    const executionId = `${task.id}:${Date.now()}`;
    const score = task.priority * 1e13 + Date.now();
    await redis.zadd('llm_task_queue_sorted', { score, member: executionId });

    const deadline = Date.now() + WAITER_TIMEOUT_S * 1000;
    let myTurn = false;

    try {
      while (Date.now() < deadline) {
        const [next] = await redis.zrange('llm_task_queue_sorted', 0, 0);
        if (next === executionId) {
          const count = await redis.incr(ACTIVE_KEY);
          if (count <= MAX_CONCURRENT) {
            await redis.zrem('llm_task_queue_sorted', executionId);
            myTurn = true;
            break;
          }
          await redis.decr(ACTIVE_KEY);
        }
        await new Promise(r => setTimeout(r, QUEUE_POLL_MS));
      }

      if (!myTurn) throw new Error('GATEKEEPER_TIMEOUT');

      return await this.executeWithModelFallback(task, dk);

    } finally {
      await redis.decr(ACTIVE_KEY).catch(() => {});
      if (!myTurn) await redis.zrem('llm_task_queue_sorted', executionId);
    }
  }

  private async executeWithModelFallback(task: LLMTask, dk: string): Promise<any> {
    const originalModel = task.openRouterParams.model;

    if (originalModel !== FALLBACK_MODEL && (await this.isBreakerOpen(originalModel))) {
      task.openRouterParams.model = FALLBACK_MODEL;
    }

    try {
      // Timeout agressivo para o modelo Pro (6s)
      const currentTimeout = task.openRouterParams.model === FALLBACK_MODEL 
        ? task.openRouterParams.timeoutMs 
        : 6000;
      
      return await this.executeDirectly(task, dk, currentTimeout);
    } catch (error: any) {
      const is429 = error?.status === 429 || error?.message?.includes('429');

      if (is429 && task.openRouterParams.model !== FALLBACK_MODEL) {
        this.banModel(originalModel);
        await redis.set(BREAKER_KEY, 'open', { ex: 60 });
        
        task.openRouterParams.model = FALLBACK_MODEL;
        return await this.executeDirectly(task, `${dk}_fb`, 20000);
      }
      throw error;
    }
  }

  private async executeDirectly(task: LLMTask, dk: string, timeout: number): Promise<any> {
    const res = await rawCallOpenRouter(
      task.openRouterParams.messages,
      task.openRouterParams.tools,
      task.openRouterParams.model,
      task.openRouterParams.temperature,
      timeout,
      task.openRouterParams.maxTokens,
      task.openRouterParams.toolChoice
    );
    
    // Adicionamos o modelo usado no retorno para o Orchestrator poder sinalizar o usuário
    const enrichedRes = typeof res === 'object' ? { ...res, modelUsed: task.openRouterParams.model } : res;

    if (res) await redis.set(dk, enrichedRes, { ex: 15 }).catch(() => {});
    return enrichedRes;
  }
}

export const llmGateway = new Gatekeeper();

export async function callOpenRouterWithPriority(
  priority: PriorityLevel,
  dropPolicy: DropPolicy,
  taskId: string,
  messages: any[],
  tools: any[],
  model: string,
  temperature: number,
  timeoutMs: number = 25000,
  maxTokens?: number,
  toolChoice?: any
): Promise<any> {
  const openRouterParams = { messages, tools, model, temperature, timeoutMs, maxTokens, toolChoice };
  
  return llmGateway.enqueue({
    id: taskId,
    priority,
    dropPolicy,
    openRouterParams,
    dedupPayload: JSON.stringify({ messages, model, tools }),
  });
}
