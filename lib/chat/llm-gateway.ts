// lib/chat/llm-gateway.ts
// Motor V10.1.0 — Fail-Fast Edition
// Fila, Semáforo e Fallback de LLM com latência otimizada.

import { Redis } from '@upstash/redis';
import { callOpenRouterWithTools as rawCallOpenRouter } from '@/lib/chat/openrouter';
import { createHash } from 'crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ---------------------------------------------------------------------------
// Configurações e Tipos
// ---------------------------------------------------------------------------
const FALLBACK_MODEL = 'google/gemini-2.5-flash';

export type PriorityLevel = 1 | 2 | 3 | 4;
export type DropPolicy    = 'never' | 'if_full';

export interface OpenRouterParams {
  messages:    any[];
  tools:       any[];
  model:       string;
  temperature: number;
  timeoutMs:   number;
  maxTokens?:  number;
  toolChoice?: any;
}

export interface LLMTask {
  id:               string; 
  priority:         PriorityLevel;
  dropPolicy:       DropPolicy;
  openRouterParams: OpenRouterParams;
  dedupPayload?:    string;
}

// ---------------------------------------------------------------------------
// Constantes de Performance
// ---------------------------------------------------------------------------
const MAX_CONCURRENT   = 3;
const ACTIVE_KEY       = 'global_llm_active';
const ACTIVE_TTL_S     = 60;
const BREAKER_KEY      = 'llm_circuit_breaker';
const BREAKER_TTL_S    = 60; // Aumentado para 1min para acalmar o Pro
const DEDUP_TTL_S      = 15;
const QUEUE_POLL_MS    = 250; // Mais rápido para reduzir latência de fila
const MAX_QUEUE_SIZE   = 200;
const WAITER_TIMEOUT_S = 45; 

// ---------------------------------------------------------------------------
// Helpers (Deduplicação e Semáforo)
// ---------------------------------------------------------------------------
function dedupKey(taskId: string, payload?: string): string {
  const suffix = payload
    ? createHash('sha256').update(payload).digest('hex').slice(0, 16)
    : 'nopayload';
  return `llm_dedup:${taskId}:${suffix}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function atomicIncr(): Promise<number> {
  await redis.set(ACTIVE_KEY, 0, { nx: true, ex: ACTIVE_TTL_S });
  const next = await redis.incr(ACTIVE_KEY);
  await redis.expire(ACTIVE_KEY, ACTIVE_TTL_S);
  return next;
}

async function safeDecr(): Promise<void> {
  try {
    const val = await redis.decr(ACTIVE_KEY);
    if (val < 0) await redis.set(ACTIVE_KEY, 0, { ex: ACTIVE_TTL_S });
  } catch { /* Auto-correção via TTL */ }
}

// ---------------------------------------------------------------------------
// Gatekeeper (Core de Execução)
// ---------------------------------------------------------------------------
class Gatekeeper {
  
  async isOverloaded(): Promise<boolean> {
    try { return ((await redis.get<number>(ACTIVE_KEY)) ?? 0) >= MAX_CONCURRENT; }
    catch { return false; }
  }

  private async isBreakerOpen(): Promise<boolean> {
    try { return (await redis.get(BREAKER_KEY)) === 'open'; }
    catch { return false; }
  }

  async enqueue(task: LLMTask): Promise<any> {
    const dk = dedupKey(task.id, task.dedupPayload);

    // 1. Dedup rápido
    const cached = await redis.get(dk).catch(() => null);
    if (cached) return cached;

    // 2. Circuit Breaker e Queue Space
    if (await this.isBreakerOpen() && task.dropPolicy === 'if_full') {
      throw new Error('GATEKEEPER_DROPPED_TASK');
    }

    const queueSize = await redis.zcard('llm_task_queue_sorted');
    if (queueSize >= MAX_QUEUE_SIZE && task.dropPolicy === 'if_full') {
      throw new Error('GATEKEEPER_DROPPED_TASK');
    }

    // 3. Registro na Fila
    const executionId = `${task.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const score = task.priority * 1e13 + Date.now();
    await redis.zadd('llm_task_queue_sorted', { score, member: executionId });

    const deadline = Date.now() + WAITER_TIMEOUT_S * 1000;
    let myTurn = false;

    try {
      while (Date.now() < deadline) {
        const [next] = await redis.zrange('llm_task_queue_sorted', 0, 0);
        
        if (next === executionId) {
          const activeCount = await atomicIncr();
          if (activeCount <= MAX_CONCURRENT) {
            await redis.zrem('llm_task_queue_sorted', executionId);
            myTurn = true;
            break;
          } else {
            await safeDecr();
          }
        }
        await sleep(QUEUE_POLL_MS);
      }

      if (!myTurn) throw new Error('GATEKEEPER_TIMEOUT');

      // 4. Execução Otimizada
      return await this.executeWithModelFallback(task, dk);

    } finally {
      if (!myTurn) await redis.zrem('llm_task_queue_sorted', executionId);
    }
  }

  private async executeWithModelFallback(task: LLMTask, dedupKeyStr: string): Promise<any> {
    const originalModel = task.openRouterParams.model;

    try {
      // ⚡ PRE-EMPTIVE FALLBACK: Se o breaker estiver aberto, pula o Pro na hora.
      if (originalModel !== FALLBACK_MODEL && (await this.isBreakerOpen())) {
        console.warn(`[Gatekeeper] Breaker aberto para ${originalModel}. Saltando para ${FALLBACK_MODEL}`);
        throw new Error('RATE_LIMIT_PREEMPTIVE');
      }

      return await this.executeDirectly(task, dedupKeyStr, false);
    } catch (error: any) {
      const isRateLimit = 
        error?.message?.includes('429') || 
        error?.status === 429 || 
        error?.message?.includes('RATE_LIMIT');

      if (isRateLimit && originalModel !== FALLBACK_MODEL) {
        // ⚡ FAIL-FAST: Não tenta retry no modelo Pro. Troca instantaneamente.
        console.warn(`[Gatekeeper] 429 no Pro. Chaveando para ${FALLBACK_MODEL} imediatamente.`);
        
        task.openRouterParams.model = FALLBACK_MODEL;
        task.openRouterParams.timeoutMs = 15000; // Resgate rápido
        const fbKey = dedupKey(`${task.id}_fb`, JSON.stringify(task.openRouterParams));
        
        return await this.executeDirectly(task, fbKey, true);
      }
      throw error;
    }
  }

  private async executeDirectly(task: LLMTask, dk: string, isFallback: boolean): Promise<any> {
    try {
      // ⚡ ZERO-RETRY no modelo primário para ganhar tempo.
      const result = await rawCallOpenRouter(
        task.openRouterParams.messages,
        task.openRouterParams.tools,
        task.openRouterParams.model,
        task.openRouterParams.temperature,
        task.openRouterParams.timeoutMs,
        task.openRouterParams.maxTokens,
        task.openRouterParams.toolChoice,
      );

      if (result) await redis.set(dk, result, { ex: DEDUP_TTL_S }).catch(() => {});
      return result;

    } catch (error: any) {
      if (error?.status === 429) {
        await redis.set(BREAKER_KEY, 'open', { ex: BREAKER_TTL_S });
      }
      throw error;
    } finally {
      if (!isFallback) await safeDecr().catch(() => {});
    }
  }
}

export const llmGateway = new Gatekeeper();

export async function callOpenRouterWithPriority(
  priority:    PriorityLevel,
  dropPolicy:  DropPolicy,
  taskId:      string,
  messages:    any[],
  tools:       any[],
  model:       string,
  temperature: number,
  timeoutMs:   number = 25_000,
  maxTokens?:  number,
  toolChoice?: any,
): Promise<any> {
  return llmGateway.enqueue({
    id: taskId,
    priority,
    dropPolicy,
    openRouterParams: { messages, tools, model, temperature, timeoutMs, maxTokens, toolChoice },
    dedupPayload: JSON.stringify({ messages, model, tools }),
  });
}
