// lib/chat/llm-gateway.ts
// V11.3.1 — Resgate de Erro 400 + Proteção Estrita de Payload e Fallback

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
    let activeModel = task.params.model;

    // ── Circuit Breaker: sincroniza estado local com Redis ──────────────────
    if (localBreaker.open && Date.now() > localBreaker.expires) {
      localBreaker.open = false;
    }

    if (!localBreaker.open && activeModel !== FALLBACK_MODEL) {
      const globalBreaker = await redis.get('llm_circuit_breaker').catch(() => null);
      if (globalBreaker === 'open') {
        localBreaker = { open: true, expires: Date.now() + 30000 };
        console.warn('[Gateway] Circuit breaker OPEN (Redis). Forçando fallback.');
      }
    }

    if (localBreaker.open && activeModel !== FALLBACK_MODEL) {
      activeModel = FALLBACK_MODEL;
    }

    // ── Helper interno para chamar o modelo ────────────────────────────────
    const callModel = async (modelToCall: string): Promise<any> => {
      const isPro = modelToCall !== FALLBACK_MODEL;
      const timeout = isPro ? 10000 : 25000;

      const hasTools = Array.isArray(task.params.tools) && task.params.tools.length > 0;

      // Limpeza estrita para evitar Erro 400:
      // Se não houver tools, ou se for o Fallback, NUNCA enviamos toolChoice customizado.
      let safeToolChoice = task.params.toolChoice;
      if (!hasTools || modelToCall === FALLBACK_MODEL) {
        safeToolChoice = undefined;
      }

      const res = await rawCallOpenRouter(
        task.params.messages,
        hasTools ? task.params.tools : undefined,
        modelToCall,
        task.params.temperature,
        timeout,
        task.params.maxTokens,
        safeToolChoice
      );

      if (hasTools && (!res.toolCalls || res.toolCalls.length === 0)) {
        console.warn(`[Gateway] Resposta textual direta de ${modelToCall} (Ignorou tools).`);
      }

      return { ...res, modelUsed: modelToCall };
    };

    // ── Tentativa principal ─────────────────────────────────────────────────
    try {
      const res = await callModel(activeModel);

      if (!res.toolCalls?.length) {
        await redis.set(dk, res, { ex: 20 }).catch(() => {});
      }

      return res;

    } catch (primaryError: any) {
      const errMsg = primaryError?.message?.toLowerCase() || '';
      const is429 = primaryError?.status === 429 || errMsg.includes('429');
      const isTimeout = errMsg.includes('timeout');
      const is400 = primaryError?.status === 400 || errMsg.includes('400');

      // Se for 400 e JÁ ESTAMOS no fallback, não tem o que fazer (erro de payload)
      if (activeModel === FALLBACK_MODEL && is400) {
        console.error(`[Gateway] Erro 400 fatal no fallback model. Payload incompatível.`);
        throw primaryError;
      }

      // Se não for recuperável E não for 400 do primário, lança o erro
      if (!is429 && !isTimeout && !is400) {
        console.error(`[Gateway] Erro primário não recuperável: ${primaryError?.message ?? primaryError}`);
        throw primaryError;
      }

      console.warn(`[Gateway] Falha em ${activeModel} (${is429 ? '429' : is400 ? '400' : 'timeout'}). Ativando fallback.`);

      // Circuit Breaker SÓ abre para problemas de rede/sobrecarga (429 ou Timeout). 
      // Erro 400 é falha de formatação e não afeta a saúde da API.
      if (is429 || isTimeout) {
        await redis.set('llm_circuit_breaker', 'open', { ex: 60 }).catch(() => {});
        localBreaker = { open: true, expires: Date.now() + 30000 };
      }

      if (activeModel === FALLBACK_MODEL) {
        console.error('[Gateway] Fallback já estava em uso e falhou. Retornando resposta degradada.');
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
        console.error(`[Gateway] Fallback falhou: ${fallbackError?.message ?? fallbackError}`);
        return {
          content: 'Estou com dificuldades para processar agora. Tente em instantes.',
          toolCalls: null,
          modelUsed: FALLBACK_MODEL,
        };
      }
    }
  }
} // ← fecha class Gatekeeper

export const llmGateway = new Gatekeeper();

export async function callOpenRouterWithPriority(
  priority: 1 | 2 | 3 | 4,
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
