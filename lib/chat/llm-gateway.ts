// lib/chat/llm-gateway.ts
// Motor V10.0.3 — Serverless-Native: Fila, Semáforo e Fallback de LLM Integrado.

import { Redis } from '@upstash/redis';
import { callOpenRouterWithTools as rawCallOpenRouter } from '@/lib/chat/openrouter';
import { createHash } from 'crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------
const FALLBACK_MODEL = 'google/gemini-2.5-flash';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

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
// Constantes
// ---------------------------------------------------------------------------

const MAX_CONCURRENT   = 3;
const ACTIVE_KEY       = 'global_llm_active';
const ACTIVE_TTL_S     = 60;
const BREAKER_KEY      = 'llm_circuit_breaker';
const BREAKER_TTL_S    = 15;
const DEDUP_TTL_S      = 15;
const QUEUE_POLL_MS    = 300;
const MAX_QUEUE_SIZE   = 200;
const WAITER_TIMEOUT_S = 45; 

// ---------------------------------------------------------------------------
// Helpers
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
  } catch { /* TTL corrige eventualmente */ }
}

// ---------------------------------------------------------------------------
// Gatekeeper (Serverless Native)
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

  private async waitForBreaker(maxWaitMs = 20_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await sleep(500);
      if (!(await this.isBreakerOpen())) return;
    }
    throw new Error('CIRCUIT_BREAKER_TIMEOUT');
  }

  private async waitForQueueSpace(maxWaitMs = 10_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await sleep(300);
      if ((await redis.zcard('llm_task_queue_sorted')) < MAX_QUEUE_SIZE) return;
    }
    throw new Error('QUEUE_FULL_TIMEOUT');
  }

  async enqueue(task: LLMTask): Promise<any> {
    const dk = dedupKey(task.id, task.dedupPayload);

    // 1. Dedup: retorna resultado cacheado se existir
    try {
      const cached = await redis.get(dk);
      if (cached !== null && cached !== undefined) {
        console.log(`[Gatekeeper] Cache hit: ${task.id}`);
        return cached;
      }
    } catch (e) {
      console.warn('[Gatekeeper] Dedup check falhou, continuando:', e);
    }

    // 2. Circuit breaker
    if (await this.isBreakerOpen()) {
      if (task.dropPolicy === 'if_full') {
        console.warn(`[Gatekeeper] ✂️ Breaker aberto. Descartando: ${task.id}`);
        throw new Error('GATEKEEPER_DROPPED_TASK');
      }
      console.warn(`[Gatekeeper] Breaker aberto. Aguardando: ${task.id}`);
      await this.waitForBreaker();
    }

    // 3. Drop policy (sobrecarga) & Queue Size
    const queueSize = await redis.zcard('llm_task_queue_sorted');
    if (queueSize >= MAX_QUEUE_SIZE) {
      if (task.dropPolicy === 'if_full') throw new Error('GATEKEEPER_DROPPED_TASK');
      await this.waitForQueueSpace();
    }

    // 4. Arquitetura Serverless de Fila e Semáforo
    const executionId = `${task.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const score = task.priority * 1e13 + Date.now();
    
    // Entra na fila do Redis
    await redis.zadd('llm_task_queue_sorted', { score, member: executionId });

    const deadline = Date.now() + WAITER_TIMEOUT_S * 1000;
    let myTurn = false;

    try {
      while (Date.now() < deadline) {
        // Verifica quem é o primeiro da fila
        const members = await redis.zrange('llm_task_queue_sorted', 0, 0);
        
        if (members && members.length > 0 && members[0] === executionId) {
          // Sou o próximo! Há slot de concorrência disponível?
          const activeCount = await atomicIncr();
          
          if (activeCount <= MAX_CONCURRENT) {
            // Slot garantido. Sai da fila.
            await redis.zrem('llm_task_queue_sorted', executionId);
            myTurn = true;
            break;
          } else {
            // Limite global atingido, recua.
            await safeDecr();
          }
        }
        
        await sleep(QUEUE_POLL_MS);
      }

      if (!myTurn) {
        throw new Error('GATEKEEPER_TIMEOUT');
      }

      // 5. Execução (Com Fallback de Modelo Integrado)
      return await this.executeWithModelFallback(task, dk);

    } finally {
      if (!myTurn) {
        await redis.zrem('llm_task_queue_sorted', executionId);
      }
    }
  }

  // ─── LÓGICA DE FALLBACK INCORPORADA NO GATEWAY ──────────────────────────────
  
private async executeWithModelFallback(task: LLMTask, dedupKeyStr: string): Promise<any> {
  const originalModel = task.openRouterParams.model;

  try {
    // Se o modelo for o experimental e o Breaker já estiver 'open', 
    // nem tenta o Pro, pula direto pro Flash para economizar 8 segundos.
    if (originalModel !== FALLBACK_MODEL && (await this.isBreakerOpen())) {
      console.warn(`[Gatekeeper] Circuit Breaker ativo. Pulando direto para ${FALLBACK_MODEL}`);
      throw new Error('RATE_LIMIT_EXCEEDED'); 
    }

    return await this.executeDirectly(task, dedupKeyStr);
  } catch (error: any) {
    const isRateLimit = 
      error?.message?.includes('429') || 
      error?.status === 429 || 
      error?.message?.includes('RATE_LIMIT_EXCEEDED');

    if (isRateLimit && originalModel !== FALLBACK_MODEL) {
      // FAIL FAST: Não tenta o retry no Pro. Chaveia pro Flash na hora.
      console.warn(`[Gatekeeper] 429 detectado. Chaveando instantaneamente para ${FALLBACK_MODEL}`);
      
      task.openRouterParams.model = FALLBACK_MODEL;
      const newDedupKey = dedupKey(`${task.id}_fb`, JSON.stringify(task.openRouterParams));
      
      // Chamada de resgate com timeout reduzido para não travar a Vercel
      task.openRouterParams.timeoutMs = 15000; 
      return await this.executeDirectly(task, newDedupKey, true);
    }

    throw error;
  }
}


  private async executeDirectly(task: LLMTask, dedupKeyStr: string, isFallbackCall = false): Promise<any> {
    // Se for a chamada de resgate, tenta apenas 1 vez rápido. Se for normal, usa os retries de prioridade.
    const maxAttempts = isFallbackCall ? 1 : (task.priority === 1 ? 2 : 1);
    let attempts = 0;
    let result: any;

    try {
      while (attempts < maxAttempts) {
        try {
          console.log(`[Gatekeeper] Executando: ${task.id} | Modelo: ${task.openRouterParams.model} (Prio: ${task.priority})`);
          result = await rawCallOpenRouter(
            task.openRouterParams.messages,
            task.openRouterParams.tools,
            task.openRouterParams.model,
            task.openRouterParams.temperature,
            task.openRouterParams.timeoutMs,
            task.openRouterParams.maxTokens,
            task.openRouterParams.toolChoice,
          );
          break; // Sucesso, sai do loop
        } catch (error: any) {
          attempts++;
          const isRateLimit = error?.message?.includes('429') || error?.status === 429;

          if (isRateLimit) {
            // Dispara o breaker no Redis avisando as outras requisições
            await redis.set(BREAKER_KEY, 'open', { ex: BREAKER_TTL_S });
            
            if (attempts < maxAttempts) {
              const delay = Math.pow(2, attempts) * 1000 + Math.random() * 500;
              console.warn(`[Gatekeeper] ⚠️ Rate limit em ${task.openRouterParams.model}. Retry em ${delay.toFixed(0)}ms...`);
              await sleep(delay);
            } else {
              throw new Error('RATE_LIMIT_EXCEEDED');
            }
          } else {
            throw error; // Erro 500, Auth, etc. Joga direto pra cima.
          }
        }
      }

      if (result !== null && result !== undefined) {
        await redis.set(dedupKeyStr, result, { ex: DEDUP_TTL_S }).catch(() => {});
      }
      
      return result;

    } finally {
      // Sempre libera o slot global, independentemente de sucesso ou erro!
      // Usamos um try/catch aqui para evitar que erro de decr mascare o erro original
      if (!isFallbackCall) {
        // Só decrementa na chamada original, pois o executeWithModelFallback 
        // já segura o slot durante toda a operação (original + fallback).
        await safeDecr().catch(() => {});
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton e export
// ---------------------------------------------------------------------------

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
  const openRouterParams: OpenRouterParams = {
    messages, tools, model, temperature, timeoutMs, maxTokens, toolChoice,
  };

  return llmGateway.enqueue({
    id:              taskId,
    priority,
    dropPolicy,
    openRouterParams,
    dedupPayload:    JSON.stringify(openRouterParams),
  });
}
