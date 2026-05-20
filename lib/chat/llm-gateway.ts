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

  // ── Circuit Breaker: sincroniza estado local com Redis ──────────────────
  if (localBreaker.open && Date.now() > localBreaker.expires) {
    localBreaker.open = false;
  }

  if (!localBreaker.open && originalModel !== FALLBACK_MODEL) {
    const globalBreaker = await redis.get('llm_circuit_breaker').catch(() => null);
    if (globalBreaker === 'open') {
      localBreaker = { open: true, expires: Date.now() + 30000 };
      console.warn('[Gateway] Circuit breaker OPEN (Redis). Forçando fallback.');
    }
  }

  if (localBreaker.open && originalModel !== FALLBACK_MODEL) {
    task.params.model = FALLBACK_MODEL;
  }

  const callModel = async (model: string): Promise<any> => {
    const isPro = model !== FALLBACK_MODEL;
    const timeout = isPro ? 10000 : 25000;

    const res = await rawCallOpenRouter(
      task.params.messages,
      task.params.tools,
      model,
      task.params.temperature,
      timeout,
      task.params.maxTokens,   // ← estava faltando no fallback
      task.params.toolChoice   // ← estava faltando no fallback
    );

    if (task.params.tools?.length > 0 && !res.toolCalls?.length) {
      console.warn(
        `[Gateway] LLM retornou texto puro — tools: ${task.params.tools
          .map((t: any) => t.function?.name)
          .join(', ')}`
      );
    }

    return { ...res, modelUsed: model };
  };

  // ── Tentativa principal ─────────────────────────────────────────────────
  try {
    const res = await callModel(task.params.model);

    if (!res.toolCalls?.length) {
      await redis.set(dk, res, { ex: 20 }).catch(() => {});
    }

    return res;

  } catch (primaryError: any) {
    const is429 = primaryError?.status === 429 || primaryError?.message?.includes('429');
    const isTimeout = primaryError?.message?.includes('timeout');

    if (!is429 && !isTimeout) {
      // Erro não recuperável — loga só mensagem, nunca stack
      console.error(`[Gateway] Erro primário não recuperável: ${primaryError?.message ?? primaryError}`);
      throw primaryError;
    }

    // ── Abre circuit breaker e tenta fallback ───────────────────────────
    console.warn(`[Gateway] ${is429 ? '429' : 'timeout'} no modelo ${task.params.model}. Ativando fallback.`);
    await redis.set('llm_circuit_breaker', 'open', { ex: 60 }).catch(() => {});
    localBreaker = { open: true, expires: Date.now() + 30000 };

    if (task.params.model === FALLBACK_MODEL) {
      // Fallback já estava em uso — retorna mensagem segura sem throw
      console.error('[Gateway] Fallback também indisponível (429). Retornando resposta degradada.');
      return {
        content: 'Estou com dificuldades para processar agora. Tente em instantes.',
        toolCalls: null,
        modelUsed: FALLBACK_MODEL,
      };
    }

    try {
      const fallbackRes = await callModel(FALLBACK_MODEL);
      if (!fallbackRes.toolCalls?.length) {
        await redis.set(dk, fallbackRes, { ex: 20 }).catch(() => {});
      }
      return fallbackRes;

    } catch (fallbackError: any) {
      // Fallback também falhou — retorna degradado, NUNCA relança
      console.error(`[Gateway] Fallback falhou: ${fallbackError?.message ?? fallbackError}`);
      return {
        content: 'Estou com dificuldades para processar agora. Tente em instantes.',
        toolCalls: null,
        modelUsed: FALLBACK_MODEL,
      };
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
