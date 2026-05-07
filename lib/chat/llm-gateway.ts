// lib/chat/llm-gateway.ts
// Motor V10.0.0 — Serverless-safe: payload 100% serializado no Redis.
//   Qualquer container pode consumir qualquer task da fila sem depender
//   de estado local (sem pendingExecutors, sem closures em RAM).

import { Redis } from '@upstash/redis';
import { callOpenRouterWithTools as rawCallOpenRouter } from '@/lib/chat/openrouter';
import { createHash } from 'crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type PriorityLevel = 1 | 2 | 3 | 4;
export type DropPolicy    = 'never' | 'if_full';

/**
 * Parâmetros completos de uma chamada ao OpenRouter.
 * Tudo que é necessário para reconstruir a chamada em qualquer container.
 */
export interface OpenRouterParams {
  messages:    any[];
  tools:       any[];
  model:       string;
  temperature: number;
  timeoutMs:   number;
  maxTokens?:  number;
  toolChoice?: any;
}

/**
 * Task enfileirável. Não carrega `execute` — a lógica de execução é
 * sempre reconstruída pelo consumer a partir de `openRouterParams`.
 */
export interface LLMTask {
  id:               string;        // ID semântico (ex: 'chat:user123')
  priority:         PriorityLevel;
  dropPolicy:       DropPolicy;
  openRouterParams: OpenRouterParams;
  /**
   * String serializada misturada ao hash de dedup.
   * Normalmente JSON.stringify(openRouterParams) — gerado em callOpenRouterWithPriority.
   */
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
const TASK_TTL_S       = 120;  // TTL do payload no Redis
const RESULT_TTL_S     = 60;   // TTL da chave de resultado (waiter tem 55s)
const WAITER_TIMEOUT_S = 55;   // Abaixo do limite de 60s da Vercel

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

/**
 * INCR atômico com TTL garantido.
 * Retorna o valor PÓS-incremento — a decisão de aceitar/rejeitar é tomada
 * sobre esse valor, eliminando a race condition entre "ler" e "incrementar".
 */
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
// Estrutura serializada no Redis
// ---------------------------------------------------------------------------

/**
 * O que fica no Redis para cada task enfileirada.
 * Contém tudo que o consumer precisa para executar a chamada
 * sem depender de nenhum estado do container que enfileirou.
 */
interface SerializedTask {
  executionId:      string;
  taskId:           string;
  priority:         PriorityLevel;
  dropPolicy:       DropPolicy;
  dedupKey:         string;
  enqueuedAt:       number;
  openRouterParams: OpenRouterParams;
}

// ---------------------------------------------------------------------------
// Gatekeeper
// ---------------------------------------------------------------------------

class Gatekeeper {
  private isRunning = false;

  // ── API pública ───────────────────────────────────────────────────────────

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
    const breakerOpen = await this.isBreakerOpen();
    if (breakerOpen) {
      if (task.dropPolicy === 'if_full') {
        console.warn(`[Gatekeeper] ✂️ Breaker aberto. Descartando: ${task.id}`);
        throw new Error('GATEKEEPER_DROPPED_TASK');
      }
      console.warn(`[Gatekeeper] Breaker aberto. Aguardando: ${task.id}`);
      await this.waitForBreaker();
    }

    // 3. Drop policy (sobrecarga)
    if (task.dropPolicy === 'if_full') {
      const overloaded = await this.isOverloaded();
      if (overloaded) {
        console.warn(`[Gatekeeper] ✂️ Sistema em stress. Descartando: ${task.id}`);
        throw new Error('GATEKEEPER_DROPPED_TASK');
      }
    }

    // 4. Limite de tamanho da fila
    const queueSize = await redis.zcard('llm_task_queue_sorted');
    if (queueSize >= MAX_QUEUE_SIZE) {
      if (task.dropPolicy === 'if_full') throw new Error('GATEKEEPER_DROPPED_TASK');
      await this.waitForQueueSpace();
    }

    return this.enqueueAndWait(task, dk);
  }

  startLoop(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.runLoop();
  }

  stopLoop(): void {
    this.isRunning = false;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async isBreakerOpen(): Promise<boolean> {
    try { return (await redis.get(BREAKER_KEY)) === 'open'; }
    catch { return false; }
  }

  private async isOverloaded(): Promise<boolean> {
    try { return ((await redis.get<number>(ACTIVE_KEY)) ?? 0) >= MAX_CONCURRENT; }
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

  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const processed = await this.processNext();
        if (!processed) await sleep(QUEUE_POLL_MS);
      } catch (e) {
        console.error('[Gatekeeper] Erro no loop:', e);
        await sleep(1000);
      }
    }
  }

  private async processNext(): Promise<boolean> {
    // Incrementa PRIMEIRO — atomicamente — e só então decide se há slot.
    const activeCount = await atomicIncr();
    if (activeCount > MAX_CONCURRENT) {
      await safeDecr();
      await sleep(200);
      return false;
    }

    // Pega o item de maior prioridade (menor score = maior urgência)
    const members = await redis.zrange('llm_task_queue_sorted', 0, 0);
    if (!members || members.length === 0) {
      await safeDecr();
      return false;
    }

    const executionId = members[0] as string;

    // ZREM atômico: se outro container chegou primeiro, retorna 0
    const removed = await redis.zrem('llm_task_queue_sorted', executionId);
    if (!removed) {
      await safeDecr();
      return false;
    }

    // Dispara sem bloquear o loop
    this.executeTask(executionId).catch(e =>
      console.error(`[Gatekeeper] executeTask falhou: ${executionId}`, e)
    );

    return true;
  }

  /**
   * Executa a task a partir dos dados serializados no Redis.
   * Não depende de nenhuma closure ou estado local —
   * funciona em qualquer container da Vercel.
   */
  private async executeTask(executionId: string): Promise<void> {
    const taskKey   = `llm_task:${executionId}`;
    const resultKey = `llm_task_result:${executionId}`;

    let serialized: SerializedTask | null = null;
    try {
      serialized = await redis.get<SerializedTask>(taskKey);
      if (!serialized) {
        console.warn(`[Gatekeeper] Task expirada ou não encontrada: ${executionId}`);
        await safeDecr();
        return;
      }
      await redis.del(taskKey);
    } catch (e) {
      console.error('[Gatekeeper] Falha ao ler task:', e);
      await safeDecr();
      return;
    }

    const { taskId, priority, dedupKey: dk, openRouterParams: p } = serialized;
    console.log(`[Gatekeeper] Executando: ${taskId} (Prio: ${priority})`);

    const maxAttempts = priority === 1 ? 2 : 1;
    let attempts = 0;
    let result: any;

    try {
      while (attempts < maxAttempts) {
        try {
          // ── HIDRATAÇÃO ───────────────────────────────────────────────────
          // Os parâmetros vieram inteiros do Redis.
          // Esta chamada acontece no container consumer, não no enqueuer.
          result = await rawCallOpenRouter(
            p.messages,
            p.tools,
            p.model,
            p.temperature,
            p.timeoutMs,
            p.maxTokens,
            p.toolChoice,
          );
          break;

        } catch (error: any) {
          attempts++;
          const isRateLimit = error?.message?.includes('429') || error?.status === 429;

          if (isRateLimit) {
            await redis.set(BREAKER_KEY, 'open', { ex: BREAKER_TTL_S });
            if (attempts < maxAttempts) {
              const delay = Math.pow(2, attempts) * 1000 + Math.random() * 500;
              console.warn(`[Gatekeeper] ⚠️ Rate limit. Aguardando ${delay.toFixed(0)}ms...`);
              await sleep(delay);
            } else {
              throw new Error('RATE_LIMIT_EXCEEDED');
            }
          } else {
            throw error;
          }
        }
      }

      if (result !== null && result !== undefined) {
        await redis.set(dk, result, { ex: DEDUP_TTL_S }).catch(() => {});
      }

      await redis.set(resultKey,
        JSON.stringify({ ok: true, value: result }),
        { ex: RESULT_TTL_S },
      );

    } catch (error: any) {
      await redis.set(resultKey,
        JSON.stringify({ ok: false, error: error.message ?? 'UNKNOWN_ERROR' }),
        { ex: RESULT_TTL_S },
      );
    } finally {
      await safeDecr();
    }
  }

  /**
   * Serializa a task inteira no Redis e aguarda o resultado via polling.
   * O enqueuer não executa nada — apenas registra e espera.
   */
  private async enqueueAndWait(task: LLMTask, dk: string): Promise<any> {
    const executionId = `${task.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const taskKey     = `llm_task:${executionId}`;
    const resultKey   = `llm_task_result:${executionId}`;

    const serialized: SerializedTask = {
      executionId,
      taskId:           task.id,
      priority:         task.priority,
      dropPolicy:       task.dropPolicy,
      dedupKey:         dk,
      enqueuedAt:       Date.now(),
      openRouterParams: task.openRouterParams,  // ← tudo serializado aqui
    };

    await redis.set(taskKey, JSON.stringify(serialized), { ex: TASK_TTL_S });

    // Score = priority * 10^13 + timestamp → ordena por prioridade, desempata por chegada
    const score = task.priority * 1e13 + Date.now();
    await redis.zadd('llm_task_queue_sorted', { score, member: executionId });

    this.startLoop();

    // Polling pelo resultado
    const deadline = Date.now() + WAITER_TIMEOUT_S * 1000;
    while (Date.now() < deadline) {
      await sleep(200);
      try {
        const raw = await redis.get<string>(resultKey);
        if (raw === null) continue;

        await redis.del(resultKey);
        const envelope = JSON.parse(raw) as { ok: true; value: any } | { ok: false; error: string };
        if (envelope.ok) return envelope.value;
        throw new Error(envelope.error);
      } catch (e: any) {
        if (!e.message?.includes('JSON')) throw e;
        // JSON malformado → continua polling
      }
    }

    // Timeout: limpa para não ser processado depois
    await redis.zrem('llm_task_queue_sorted', executionId);
    await redis.del(taskKey);
    throw new Error('GATEKEEPER_TIMEOUT');
  }
}

// ---------------------------------------------------------------------------
// Singleton e export
// ---------------------------------------------------------------------------

export const llmGateway = new Gatekeeper();

// Em serverless, cada request dispara startLoop(). O guard `isRunning`
// garante que apenas um loop rode por instância de container.
llmGateway.startLoop();

/**
 * Ponto de entrada público.
 * Monta o LLMTask com parâmetros 100% serializáveis e enfileira.
 */
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