// lib/chat/llm-gateway.ts
// Motor V8.13.2 — Gatekeeper: Priority Queue, Rate Limiter, Dedup e Exponential Backoff

import { Redis } from '@upstash/redis';
// Importa a função original de rede que se comunica com o OpenRouter
import { callOpenRouterWithTools as rawCallOpenRouter } from '@/lib/chat/openrouter';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export type PriorityLevel = 1 | 2 | 3 | 4;
export type DropPolicy = 'never' | 'if_full';

export interface LLMTask<T> {
  id: string;               // Chave única para Dedup no Redis
  priority: PriorityLevel;  // 1: Chat, 2: L4/Classifiers, 3: Extractors, 4: Critic/Promoter
  dropPolicy: DropPolicy;   // 'never' (vai pro backoff) | 'if_full' (descarta se engargalar)
  execute: () => Promise<T>;
}

class Gatekeeper {
  private activeCount = 0;
  private readonly maxConcurrent = 3; // Limite de conexões simultâneas com o OpenRouter
  private readonly maxQueueSize = 8;  // Tamanho máximo da fila antes de aplicar Load Shedding
  private queue: Array<{ task: LLMTask<any>; resolve: (v: any) => void; reject: (e: any) => void }> = [];

  async enqueue<T>(task: LLMTask<T>): Promise<T> {
    const dedupKey = `llm_dedup:${task.id}`;

    // 1. DEDUPLICAÇÃO CROSS-CONTAINER (Redis)
    try {
      const cached = await redis.get<T>(dedupKey);
      if (cached) {
        console.log(`[Gatekeeper] Cache hit (Dedup) para a tarefa: ${task.id}`);
        return cached;
      }
    } catch (e) {
      console.warn(`[Gatekeeper] Erro ao ler dedup do Redis para ${task.id}`, e);
    }

    // 2. LOAD SHEDDING (Descarte Seletivo)
    if (this.queue.length >= this.maxQueueSize && task.dropPolicy === 'if_full') {
      console.warn(`[Gatekeeper] Fila cheia (${this.queue.length}). Descartando tarefa: ${task.id}`);
      throw new Error('GATEKEEPER_DROPPED_TASK');
    }

    // 3. ENFILEIRAMENTO POR PRIORIDADE
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      // Reordena: números menores (1) vão para o início da fila
      this.queue.sort((a, b) => a.task.priority - b.task.priority);

      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.queue.length === 0) return;

    // 1. CHECAGEM DISTRIBUÍDA DE CONCORRÊNCIA (Semáforo Global Atômico)
    const activeCount = await redis.incr('global_llm_active');

    // Se foi o primeiro a entrar, garante que o semáforo não vai ficar preso para sempre
    if (activeCount === 1) {
      await redis.expire('global_llm_active', 45);
    }

    // Se lotou, devolve a vaga e entra em espera
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
      console.log(`[Gatekeeper] Executando: ${item.task.id} (Prioridade: ${item.task.priority})`);

      let result;
      let attempts = 0;
      const maxAttempts = item.task.priority === 1 ? 4 : 2;

      while (attempts < maxAttempts) {
        try {
          result = await item.task.execute();
          break;
        } catch (error: any) {
          attempts++;
          const isRateLimit = error?.message?.includes('429') || error?.status === 429;
          if (isRateLimit && attempts < maxAttempts) {
            const delay = (Math.pow(2, attempts) * 1000) + Math.floor(Math.random() * 500);
            await new Promise(r => setTimeout(r, delay));
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
      // Libera a vaga no semáforo global
      await redis.decr('global_llm_active');
      this.processQueue();
    }
  }
}

// Instância Singleton exportada
export const llmGateway = new Gatekeeper();

// ============================================================================
// Wrapper (Drop-in Replacement) para a sua função de OpenRouter
// ============================================================================
export async function callOpenRouterWithPriority(
  priority: PriorityLevel,
  dropPolicy: DropPolicy,
  taskId: string,
  messages: any[],
  tools: any[],
  model: string,
  temperature: number,
  timeoutMs: number = 35000,
  maxTokens?: number,
  toolChoice?: any
) {
  return llmGateway.enqueue({
    id: taskId,
    priority,
    dropPolicy,
    execute: async () => {
      // Repassa a chamada para a sua função de infraestrutura original
      return rawCallOpenRouter(
        messages,
        tools,
        model,
        temperature,
        timeoutMs,
        maxTokens,
        toolChoice
      );
    }
  });
}
