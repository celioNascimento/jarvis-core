// lib/chat/llm-gateway.ts
// Motor V8.13.3 — Gatekeeper com Graceful Degradation e Circuit Breaker

import { Redis } from '@upstash/redis';
import { callOpenRouterWithTools as rawCallOpenRouter } from '@/lib/chat/openrouter';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export type PriorityLevel = 1 | 2 | 3 | 4;
export type DropPolicy = 'never' | 'if_full';

export interface LLMTask<T> {
  id: string;               
  priority: PriorityLevel;  
  dropPolicy: DropPolicy;   
  execute: () => Promise<T>;
}

class Gatekeeper {
  private readonly maxConcurrent = 3; 

  // NOVO: Sensor de estresse do sistema
  async isOverloaded(): Promise<boolean> {
    try {
      // 1. O Disjuntor desarmou? (Acabamos de tomar um 429)
      const breaker = await redis.get('llm_circuit_breaker');
      if (breaker === 'open') return true;

      // 2. A fila global está lotada?
      const activeCount = await redis.get<number>('global_llm_active') || 0;
      return activeCount >= this.maxConcurrent;
    } catch {
      return false; // Em caso de falha no Redis, assume que está ok para não travar
    }
  }

  async enqueue<T>(task: LLMTask<T>): Promise<T> {
    const dedupKey = `llm_dedup:${task.id}`;

    // 1. DEDUPLICAÇÃO
    try {
      const cached = await redis.get<T>(dedupKey);
      if (cached) {
        console.log(`[Gatekeeper] Cache hit (Dedup) para: ${task.id}`);
        return cached;
      }
    } catch (e) {}

    // 2. LOAD SHEDDING GLOBAL (A Guilhotina)
    if (task.dropPolicy === 'if_full') {
      const overloaded = await this.isOverloaded();
      if (overloaded) {
        console.warn(`[Gatekeeper] ✂️ Sistema em STRESS. Descartando tarefa de luxo: ${task.id}`);
        // Retorna um erro amigável e controlado para não quebrar o background
        throw new Error('GATEKEEPER_DROPPED_TASK'); 
      }
    }

    // 3. ENFILEIRAMENTO
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.queue.sort((a, b) => a.task.priority - b.task.priority);
      this.processQueue();
    });
  }

  private queue: Array<{ task: LLMTask<any>; resolve: (v: any) => void; reject: (e: any) => void }> = [];

  private async processQueue() {
    if (this.queue.length === 0) return;

    const activeCount = await redis.incr('global_llm_active');
    if (activeCount === 1) await redis.expire('global_llm_active', 45);

    if (activeCount > this.maxConcurrent) {
      await redis.decr('global_llm_active');
      setTimeout(() => this.processQueue(), 500);
      return;
    }

    const item = this.queue.shift();
    if (!item) {
      await redis.decr('global_llm_active');
      return;
    }

    try {
      console.log(`[Gatekeeper] Executando: ${item.task.id} (Prio: ${item.task.priority})`);

      let result;
      let attempts = 0;
      const maxAttempts = item.task.priority === 1 ? 2 : 1; // Reduzido para evitar timeout do Vercel

      while (attempts < maxAttempts) {
        try {
          result = await item.task.execute();
          break;
        } catch (error: any) {
          attempts++;
          const isRateLimit = error?.message?.includes('429') || error?.status === 429;
          
          if (isRateLimit) {
            // NOVO: Desarma o disjuntor global por 15 segundos para avisar o resto do sistema
            await redis.set('llm_circuit_breaker', 'open', { ex: 15 });
            
            if (attempts < maxAttempts) {
              const delay = (Math.pow(2, attempts) * 1000) + Math.floor(Math.random() * 500);
              console.warn(`[Gatekeeper] ⚠️ Rate Limit. Pausa de ${delay}ms...`);
              await new Promise(r => setTimeout(r, delay));
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
      }

      await redis.set(`llm_dedup:${item.task.id}`, result, { ex: 60 });
      item.resolve(result);

    } catch (error: any) {
      item.reject(error);
    } finally {
      await redis.decr('global_llm_active');
      this.processQueue();
    }
  }
}

export const llmGateway = new Gatekeeper();

export async function callOpenRouterWithPriority(
  priority: PriorityLevel, dropPolicy: DropPolicy, taskId: string, messages: any[], tools: any[], model: string, temperature: number, timeoutMs: number = 25000, maxTokens?: number, toolChoice?: any
) {
  return llmGateway.enqueue({
    id: taskId, priority, dropPolicy,
    execute: async () => rawCallOpenRouter(messages, tools, model, temperature, timeoutMs, maxTokens, toolChoice)
  });
}
