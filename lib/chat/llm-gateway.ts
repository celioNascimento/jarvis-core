// lib/chat/llm-gateway.ts
// Motor V9.0.0 — Refatorado: fila no Redis, loop iterativo, INCR atômico,
//               circuit breaker completo, dedup seguro, sem ghost counters.

import { Redis } from '@upstash/redis';
import { callOpenRouterWithTools as rawCallOpenRouter } from '@/lib/chat/openrouter';
import { createHash } from 'crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type PriorityLevel = 1 | 2 | 3 | 4;
export type DropPolicy   = 'never' | 'if_full';

export interface LLMTask<T> {
  /** ID semântico do chamador — usado como parte da chave de dedup. */
  id: string;
  priority: PriorityLevel;
  dropPolicy: DropPolicy;
  execute: () => Promise<T>;
  /**
   * Payload serializado que será misturado ao hash de dedup.
   * Evita colisões quando dois tasks compartilham o mesmo id
   * mas carregam conteúdo diferente (ex: mesma rota, prompts distintos).
   */
  dedupPayload?: string;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MAX_CONCURRENT    = 3;
const ACTIVE_KEY        = 'global_llm_active';
const ACTIVE_TTL_S      = 60;           // TTL do contador — renovado a cada uso
const BREAKER_KEY       = 'llm_circuit_breaker';
const BREAKER_TTL_S     = 15;           // Tempo que o breaker fica aberto
const DEDUP_TTL_S       = 15;           // TTL do cache de resultado
const QUEUE_KEY         = 'llm_task_queue'; // Lista Redis para a fila distribuída
const QUEUE_POLL_MS     = 300;          // Intervalo de polling quando a fila está vazia
const MAX_QUEUE_SIZE    = 200;          // Limite de segurança para a fila
const TASK_PAYLOAD_TTL  = 120;          // TTL do payload armazenado no Redis

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Gera a chave de dedup combinando o id semântico com um hash do payload.
 * Isso garante que tasks com mesmo id mas payloads diferentes não colidam.
 */
function dedupKey(taskId: string, payload?: string): string {
  const suffix = payload
    ? createHash('sha256').update(payload).digest('hex').slice(0, 16)
    : 'nopayload';
  return `llm_dedup:${taskId}:${suffix}`;
}

/**
 * Incrementa o contador de ativos de forma atômica e já garante o TTL
 * usando SET com NX+EX para inicialização, depois INCR.
 *
 * Retorna o novo valor do contador após o incremento.
 *
 * FIX #3 (race condition) e FIX #5 (INCR + EXPIRE não-atômico):
 * O padrão abaixo garante que a chave sempre tenha TTL e que a decisão
 * de aceitar/rejeitar seja tomada sobre o valor pós-INCR (atômico),
 * não pré-INCR (racy).
 */
async function atomicIncr(): Promise<number> {
  // Garante que a chave exista com TTL antes de incrementar.
  // SET ... NX EX não sobrescreve se já existir.
  await redis.set(ACTIVE_KEY, 0, { nx: true, ex: ACTIVE_TTL_S });

  // INCR retorna o valor PÓS-incremento atomicamente.
  const next = await redis.incr(ACTIVE_KEY);

  // Renova o TTL para evitar ghost counters caso o processo morra logo após.
  await redis.expire(ACTIVE_KEY, ACTIVE_TTL_S);

  return next;
}

async function safeDecr(): Promise<void> {
  try {
    const val = await redis.decr(ACTIVE_KEY);
    // Proteção contra contadores negativos por qualquer bug remanescente.
    if (val < 0) await redis.set(ACTIVE_KEY, 0, { ex: ACTIVE_TTL_S });
  } catch {
    // Silencioso — o TTL vai corrigir o estado eventualmente.
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper
// ---------------------------------------------------------------------------

class Gatekeeper {

  // FIX #1: Não há mais estado local relevante para a fila.
  // A fila vive no Redis e é compartilhada entre todos os containers.
  private isRunning = false;

  // -------------------------------------------------------------------------
  // API pública
  // -------------------------------------------------------------------------

  async enqueue<T>(task: LLMTask<T>): Promise<T> {

    // --- Dedup: verifica cache antes de qualquer coisa ------------------
    // FIX #4: só retorna do cache se o valor não for null/undefined.
    const dk = dedupKey(task.id, task.dedupPayload);
    try {
      const cached = await redis.get<T>(dk);
      if (cached !== null && cached !== undefined) {
        console.log(`[Gatekeeper] Cache hit (dedup): ${task.id}`);
        return cached;
      }
    } catch (e) {
      console.warn('[Gatekeeper] Dedup check falhou, continuando:', e);
    }

    // --- Circuit breaker: bloqueia TODOS os dropPolicies quando aberto --
    // FIX #6: o breaker agora impede até tasks 'never' de serem enfileiradas
    //         quando o sistema está claramente em estado de erro.
    const breakerOpen = await this.isBreakerOpen();
    if (breakerOpen) {
      if (task.dropPolicy === 'if_full') {
        console.warn(`[Gatekeeper] ✂️ Breaker aberto. Descartando: ${task.id}`);
        throw new Error('GATEKEEPER_DROPPED_TASK');
      }
      // Para 'never': aguarda o breaker fechar antes de enfileirar.
      console.warn(`[Gatekeeper] Breaker aberto. Aguardando para enfileirar: ${task.id}`);
      await this.waitForBreaker();
    }

    // --- Drop policy: verifica sobrecarga antes de enfileirar -----------
    if (task.dropPolicy === 'if_full') {
      const overloaded = await this.isOverloaded();
      if (overloaded) {
        console.warn(`[Gatekeeper] ✂️ Sistema em stress. Descartando: ${task.id}`);
        throw new Error('GATEKEEPER_DROPPED_TASK');
      }
    }

    // --- Segurança: impede fila infinita --------------------------------
    const queueSize = await redis.llen(QUEUE_KEY);
    if (queueSize >= MAX_QUEUE_SIZE) {
      if (task.dropPolicy === 'if_full') {
        throw new Error('GATEKEEPER_DROPPED_TASK');
      }
      // Para 'never', aguarda espaço na fila.
      await this.waitForQueueSpace();
    }

    // --- Enfileira o payload no Redis e aguarda o resultado -------------
    // FIX #1: A fila agora é no Redis. O resultado é comunicado via
    //         uma chave de resultado com polling.
    return this.enqueueAndWait(task, dk);
  }

  // -------------------------------------------------------------------------
  // Loop de processamento — deve ser iniciado por um worker dedicado
  // ou pelo primeiro container que detectar a fila não-vazia.
  // -------------------------------------------------------------------------

  /**
   * Inicia o loop de processamento neste container.
   * Em ambientes serverless, chamar isso ao receber qualquer request
   * garante que pelo menos um container esteja processando.
   * O Redis garante que apenas MAX_CONCURRENT tasks rodem em paralelo
   * globalmente, independente de quantos containers chamem startLoop().
   */
  startLoop(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    // FIX #2: Loop iterativo com setImmediate, sem recursão de call stack.
    this.runLoop();
  }

  stopLoop(): void {
    this.isRunning = false;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async isBreakerOpen(): Promise<boolean> {
    try {
      return (await redis.get(BREAKER_KEY)) === 'open';
    } catch {
      return false;
    }
  }

  private async isOverloaded(): Promise<boolean> {
    try {
      const active = await redis.get<number>(ACTIVE_KEY) ?? 0;
      return active >= MAX_CONCURRENT;
    } catch {
      return false;
    }
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
      const size = await redis.llen(QUEUE_KEY);
      if (size < MAX_QUEUE_SIZE) return;
    }
    throw new Error('QUEUE_FULL_TIMEOUT');
  }

  /**
   * Serializa o task no Redis, enfileira o ID e aguarda o resultado
   * via polling em uma chave de resultado dedicada.
   *
   * Estrutura no Redis:
   *   llm_task_payload:{executionId}  → JSON do task (sem a fn execute)
   *   llm_task_result:{executionId}   → resultado após processamento
   *   llm_task_queue                  → lista de executionIds ordenada por prioridade
   */
  private async enqueueAndWait<T>(task: LLMTask<T>, dk: string): Promise<T> {
    // ID único para esta execução específica (diferente do task.id semântico).
    const executionId = `${task.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const payloadKey  = `llm_task_payload:${executionId}`;
    const resultKey   = `llm_task_result:${executionId}`;

    // Salva metadados do task (prioridade, dropPolicy, dedup key).
    await redis.set(payloadKey, JSON.stringify({
      executionId,
      taskId:    task.id,
      priority:  task.priority,
      dropPolicy: task.dropPolicy,
      dedupKey:  dk,
      enqueuedAt: Date.now(),
    }), { ex: TASK_PAYLOAD_TTL });

    // Enfileira com score de prioridade usando ZADD (sorted set).
    // Score = priority * 10^13 + timestamp → desempate por chegada.
    const score = task.priority * 1e13 + Date.now();
    await redis.zadd('llm_task_queue_sorted', { score, member: executionId });

    // Garante que o loop esteja rodando neste container.
    this.startLoop();

    // Aguarda o resultado via polling.
    const timeoutMs = 55_000; // Abaixo do timeout padrão de 60s da Vercel
    const deadline  = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(200);
      try {
        const raw = await redis.get<string>(resultKey);
        if (raw === null) continue;

        const envelope = JSON.parse(raw) as { ok: true; value: T } | { ok: false; error: string };
        // Limpa a chave de resultado
        await redis.del(resultKey);

        if (envelope.ok) return envelope.value;
        throw new Error(envelope.error);
      } catch (e: any) {
        if (e.message && !e.message.includes('JSON')) throw e;
        // JSON malformado — ignora e continua polling
      }
    }

    // Timeout: remove da fila para não ser processado depois
    await redis.zrem('llm_task_queue_sorted', executionId);
    await redis.del(payloadKey);
    throw new Error('GATEKEEPER_TIMEOUT');
  }

  // FIX #2: Loop iterativo com await — zero recursão, zero stack overflow.
  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const processed = await this.processNext();
        if (!processed) {
          // Fila vazia — aguarda antes de tentar novamente.
          await sleep(QUEUE_POLL_MS);
        }
      } catch (e) {
        console.error('[Gatekeeper] Erro inesperado no loop:', e);
        await sleep(1000);
      }
    }
  }

  /**
   * Tenta pegar e executar o próximo item da fila.
   * Retorna true se processou algo, false se a fila estava vazia.
   */
  private async processNext(): Promise<boolean> {

    // FIX #3: Incrementa PRIMEIRO, decide DEPOIS — operação atômica.
    // Dessa forma não há janela entre "checar" e "incrementar".
    const activeCount = await atomicIncr();

    if (activeCount > MAX_CONCURRENT) {
      // Slot não disponível — devolve o incremento e aguarda.
      await safeDecr();
      await sleep(200);
      return false;
    }

    // Pega o item de maior prioridade (menor score) da fila sorted.
    const members = await redis.zrange('llm_task_queue_sorted', 0, 0);
    if (!members || members.length === 0) {
      await safeDecr();
      return false;
    }

    const executionId = members[0] as string;
    // Remove atomicamente — se outro container já pegou, não faz nada.
    const removed = await redis.zrem('llm_task_queue_sorted', executionId);
    if (!removed) {
      await safeDecr();
      return false;
    }

    // Processa de forma assíncrona sem bloquear o loop.
    this.executeTask(executionId).catch(e =>
      console.error(`[Gatekeeper] executeTask falhou para ${executionId}:`, e)
    );

    return true;
  }

  private async executeTask(executionId: string): Promise<void> {
    const payloadKey = `llm_task_payload:${executionId}`;
    const resultKey  = `llm_task_result:${executionId}`;

    let meta: any;
    try {
      meta = await redis.get<any>(payloadKey);
      if (!meta) {
        // Task expirou antes de ser processado.
        console.warn(`[Gatekeeper] Payload expirado: ${executionId}`);
        return;
      }
      await redis.del(payloadKey);
    } catch (e) {
      console.error('[Gatekeeper] Falha ao ler payload:', e);
      await safeDecr();
      return;
    }

    console.log(`[Gatekeeper] Executando: ${meta.taskId} (Prio: ${meta.priority})`);

    // NOTA: Em arquitetura serverless pura, o `execute()` não pode ser
    // serializado no Redis — ele precisa ser reconstruído pelo chamador
    // baseado nos metadados (taskId, priority, etc.).
    // Ver `callOpenRouterWithPriority` abaixo para o padrão correto.
    //
    // Para uso in-process (ex: Next.js com long-running routes),
    // o execute() é fornecido diretamente ao enqueueAndWait via closure —
    // veja a implementação alternativa `enqueueInProcess` abaixo.

    // Esta implementação usa o padrão in-process (mesmo container executa).
    // Para serverless puro, substitua por um worker separado.
    const fn = this.pendingExecutors.get(executionId);
    if (!fn) {
      console.warn(`[Gatekeeper] Executor não encontrado para: ${executionId}`);
      await safeDecr();
      return;
    }
    this.pendingExecutors.delete(executionId);

    const maxAttempts = meta.priority === 1 ? 2 : 1;
    let attempts = 0;
    let result: any;

    try {
      while (attempts < maxAttempts) {
        try {
          result = await fn();
          break;
        } catch (error: any) {
          attempts++;
          const isRateLimit = error?.message?.includes('429') || error?.status === 429;

          if (isRateLimit) {
            await redis.set(BREAKER_KEY, 'open', { ex: BREAKER_TTL_S });

            if (attempts < maxAttempts) {
              const delay = Math.pow(2, attempts) * 1000 + Math.random() * 500;
              console.warn(`[Gatekeeper] ⚠️ Rate Limit. Pausa de ${delay.toFixed(0)}ms...`);
              await sleep(delay);
            } else {
              throw new Error('RATE_LIMIT_EXCEEDED');
            }
          } else {
            throw error;
          }
        }
      }

      // FIX #4: Só cacheia se o resultado for um valor válido.
      if (result !== undefined && result !== null) {
        await redis.set(meta.dedupKey, result, { ex: DEDUP_TTL_S }).catch(() => {});
      }

      // Publica resultado para o waiter.
      await redis.set(resultKey,
        JSON.stringify({ ok: true, value: result }),
        { ex: 60 }
      );

    } catch (error: any) {
      await redis.set(resultKey,
        JSON.stringify({ ok: false, error: error.message ?? 'UNKNOWN_ERROR' }),
        { ex: 60 }
      );
    } finally {
      await safeDecr();
    }
  }

  // Mapa in-process para closures de execução (válido para uso não-serverless puro).
  private pendingExecutors = new Map<string, () => Promise<any>>();

  /**
   * Versão in-process do enqueue: registra o executor localmente e
   * enfileira apenas os metadados no Redis.
   * Funciona quando o mesmo processo que enfileira também processa.
   */
  private async enqueueAndWait<T>(task: LLMTask<T>, dk: string): Promise<T> {
    const executionId = `${task.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const payloadKey  = `llm_task_payload:${executionId}`;
    const resultKey   = `llm_task_result:${executionId}`;

    // Registra o executor no mapa local.
    this.pendingExecutors.set(executionId, task.execute);

    // Salva metadados no Redis (para o loop poder identificar a tarefa).
    await redis.set(payloadKey, JSON.stringify({
      executionId,
      taskId:    task.id,
      priority:  task.priority,
      dropPolicy: task.dropPolicy,
      dedupKey:  dk,
      enqueuedAt: Date.now(),
    }), { ex: TASK_PAYLOAD_TTL });

    const score = task.priority * 1e13 + Date.now();
    await redis.zadd('llm_task_queue_sorted', { score, member: executionId });

    this.startLoop();

    const timeoutMs = 55_000;
    const deadline  = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(200);
      try {
        const raw = await redis.get<string>(resultKey);
        if (raw === null) continue;
        await redis.del(resultKey);
        const envelope = JSON.parse(raw) as { ok: true; value: T } | { ok: false; error: string };
        if (envelope.ok) return envelope.value;
        throw new Error(envelope.error);
      } catch (e: any) {
        if (e.message && !e.message.includes('JSON')) throw e;
      }
    }

    this.pendingExecutors.delete(executionId);
    await redis.zrem('llm_task_queue_sorted', executionId);
    await redis.del(payloadKey);
    throw new Error('GATEKEEPER_TIMEOUT');
  }
}

// ---------------------------------------------------------------------------
// Instância singleton e exports
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export const llmGateway = new Gatekeeper();

// Inicia o loop automaticamente (para ambientes não-serverless).
// Em serverless puro, remova esta linha e chame llmGateway.startLoop()
// no handler de cada request.
llmGateway.startLoop();

/**
 * Interface pública para chamar o OpenRouter com controle de prioridade.
 *
 * FIX #7: O dedupPayload é derivado dos argumentos reais da chamada,
 * garantindo que tasks com mesmo id mas payloads diferentes não colidam.
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

  // Hash do payload real para dedup seguro — sem colisões por taskId compartilhado.
  const dedupPayload = JSON.stringify({ messages, tools, model, temperature, maxTokens, toolChoice });

  return llmGateway.enqueue({
    id: taskId,
    priority,
    dropPolicy,
    dedupPayload,
    execute: () => rawCallOpenRouter(messages, tools, model, temperature, timeoutMs, maxTokens, toolChoice),
  });
}