// lib/chat/llm-gateway.ts
// Motor V8.13.4 — Gatekeeper com Ghost Counter Protection e Loop Lock

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
  private isProcessingLoop = false; // <-- TRAVA PARA EVITAR VAZAMENTO DE MEMÓRIA NA VERCEL

  async isOverloaded(): Promise<boolean> {
    try {
      const breaker = await redis.get('llm_circuit_breaker');
      if (breaker === 'open') return true;

      const activeCount = await redis.get<number>('global_llm_active') || 0;
      return activeCount >= this.maxConcurrent;
    } catch {
      return false; 
    }
  }

  async enqueue<T>(task: LLMTask<T>): Promise<T> {
    const dedupKey = `llm_dedup:${task.id}`;

    try {
      const cached = await redis.get<T>(dedupKey);
      if (cached) {
        console.log(`[Gatekeeper] Cache hit (Dedup) para: ${task.id}`);
        return cached;
      }
    } catch (e) {}

    if (task.dropPolicy === 'if_full') {
      const overloaded = await this.isOverloaded();
      if (overloaded) {
        console.warn(`[Gatekeeper] ✂️ Sistema em STRESS. Descartando tarefa de luxo: ${task.id}`);
        throw new Error('GATEKEEPER_DROPPED_TASK'); 
      }
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.queue.sort((a, b) => a.task.priority - b.task.priority);
      
      // Só dispara o loop se não houver um já rodando neste container
      if (!this.isProcessingLoop) {
        this.processQueue();
      }
    });
  }

  private queue: Array<{ task: LLMTask<any>; resolve: (v: any) => void; reject: (e: any) => void }> = [];

  private async processQueue() {
    if (this.queue.length === 0) {
      this.isProcessingLoop = false;
      return;
    }

    this.isProcessingLoop = true;

    // INCREMENTO SEGURO CONTRA "GHOST COUNTERS"
    const activeCount = await redis.incr('global_llm_active');
    await redis.expire('global_llm_active', 45); // <-- AGORA RENOVA SEMPRE, SALVA VIDAS!

    if (activeCount > this.maxConcurrent) {
      await redis.decr('global_llm_active');
      setTimeout(() => this.processQueue(), 500);
      return;
    }

    const item = this.queue.shift();
    if (!item) {
      await redis.decr('global_llm_active');
      this.isProcessingLoop = false;
      return;
    }

    try {
      console.log(`[Gatekeeper] Executando: ${item.task.id} (Prio: ${item.task.priority})`);

      let result;
      let attempts = 0;
      const maxAttempts = item.task.priority === 1 ? 2 : 1; 

      while (attempts < maxAttempts) {
        try {
          result = await item.task.execute();
          break;
        } catch (error: any) {
          attempts++;
          const isRateLimit = error?.message?.includes('429') || error?.status === 429;
          
          if (isRateLimit) {
            await redis.set('llm_circuit_breaker', 'open', { ex: 15 });
            
            if (attempts < maxAttempts) {
              const delay = (Math.pow(2, attempts) * 1000) + Math.floor(Math.random() * 500);
              console.warn(`[Gatekeeper] ⚠️ Rate Limit. Pausa de ${delay}ms...`);
              await new Promise(r => setTimeout(r, delay));
            } else {
              // Devolvemos um erro claro se todas as tentativas falharem
              throw new Error("RATE_LIMIT_EXCEEDED");
            }
          } else {
            throw error;
          }
        }
      }

      await redis.set(`llm_dedup:${item.task.id}`, result, { ex: 15 });
      item.resolve(result);

    } catch (error: any) {
      item.reject(error);
    } finally {
      // DECREMENTO SEGURO
      try { await redis.decr('global_llm_active'); } catch(e) {}
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
