// lib/chat/llm-gateway.ts
// V11.0.0 — Priority-Aware & Atomic Pipeline Strategy

import { Redis } from '@upstash/redis';
import { callOpenRouterWithTools as rawCallOpenRouter } from '@/lib/chat/openrouter';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const FALLBACK_MODEL = 'google/gemini-2.0-flash';
const CONCURRENCY_LIMIT = 3;

// Cache local para o Circuit Breaker (evita hits desnecessários ao Redis no mesmo processo)
let localBreaker = { open: false, expires: 0 };

function edgeSafeHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

class Gatekeeper {
  /**
   * Enfileiramento inteligente: Prioridade 1 (Refatoração/Arquitetura) tem precedência Pro.
   * Prioridades 2-4 (Chat/Rotina) usam Fail-to-Flash se o sistema estiver carregado.
   */
  async enqueue(task: any): Promise<any> {
    const dedupKey = `llm_dedup:${task.id}:${edgeSafeHash(task.dedupPayload || '')}`;
    
    // 1. PIPELINE ATÔMICO: Dedup + Contador em uma única viagem de rede
    const [cached, activeCount] = await redis.pipeline()
      .get(dedupKey)
      .incr('global_llm_active')
      .exec();

    if (cached) {
      await redis.decr('global_llm_active');
      return cached;
    }

    try {
      const currentLoad = activeCount as number;
      const isOverloaded = currentLoad > CONCURRENCY_LIMIT;

      // 2. DECISÃO DE ROBUSTEZ POR PRIORIDADE
      if (isOverloaded) {
        // Prioridade 1 (Código/Implementação): Espera controlada por vaga Pro
        if (task.priority === 1) {
          await this.waitSmartly(4000); // Aguarda até 4s por um slot Pro
        } 
        // Prioridades > 1: Downgrade imediato para Flash para não travar o fluxo
        else if (task.params.model !== FALLBACK_MODEL) {
          console.warn(`[Gateway] Carga alta (${currentLoad}). Downgrade silencioso (Prioridade ${task.priority}).`);
          task.params.model = FALLBACK_MODEL;
        }
      }

      return await this.executeWithFallback(task, dedupKey);
    } finally {
      // 3. CLEANUP: Libera o slot
      await redis.decr('global_llm_active').catch(() => {});
    }
  }

  /**
   * Polling controlado e lento para tarefas de alta prioridade (Refactoring).
   */
  private async waitSmartly(ms: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const count = await redis.get<number>('global_llm_active').catch(() => 99);
      if ((count || 0) <= CONCURRENCY_LIMIT) return;
      await new Promise(r => setTimeout(r, 1000)); // Polling de 1s (máximo 4 chamadas)
    }
  }

  private async executeWithFallback(task: any, dk: string): Promise<any> {
    const originalModel = task.params.model;
    
    // Circuit Breaker local (economiza Redis)
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
      const timeout = isPro ? 10000 : 25000; // Modelos Pro são mais rápidos ou falham logo

      const res = await rawCallOpenRouter(
        task.params.messages, 
        task.params.tools, 
        task.params.model, 
        task.params.temperature, 
        timeout, 
        task.params.maxTokens, 
        task.params.toolChoice
      );

      const enriched = { ...res, modelUsed: task.params.model };
      if (res) await redis.set(dk, enriched, { ex: 20 }).catch(() => {});
      return enriched;

    } catch (error: any) {
      // Fallback crítico: Se o Pro falhar (429 ou Timeout), tenta o Flash uma última vez
      if (task.params.model !== FALLBACK_MODEL && (error?.status === 429 || error?.message?.includes('timeout'))) {
        await redis.set('llm_circuit_breaker', 'open', { ex: 60 });
        return await rawCallOpenRouter(task.params.messages, task.params.tools, FALLBACK_MODEL, task.params.temperature, 20000);
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
    id: taskId, priority,
    params: { messages, tools, model, temperature, timeoutMs, maxTokens, toolChoice },
    dedupPayload: JSON.stringify({ messages, model, tools })
  });
}
