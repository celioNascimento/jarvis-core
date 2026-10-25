// lib/chat/llm-gateway.ts
// V11.7 — Controle de carga autocorretivo (conjunto ordenado com expiração).
// O contador antigo `global_llm_active` só subia quando uma invocação morria antes do
// `finally` e nunca expirava: ficava preso em ~58, causando "Downgrade preventivo" em toda
// tarefa de background e 4 s de espera inútil em toda resposta de fallback do chat.
// V11.6.5 — FALLBACK_MODEL atualizado para gemini-2.5-flash (2.0-flash descontinuado no OpenRouter)

import { Redis } from '@upstash/redis';
import { callOpenRouterWithTools as rawCallOpenRouter, ToolDefinition, ToolChoice } from '@/lib/chat/openrouter';

// ── Tipagens Estritas ────────────────────────────────────────────────────
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface LLMParams {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  model: string;
  temperature: number;
  timeoutMs: number;
  maxTokens?: number;
  toolChoice?: ToolChoice;
}

export interface GatewayTask {
  id: string;
  priority: 1 | 2 | 3 | 4;
  params: LLMParams;
  dedupPayload: string;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: any[] | null;
  modelUsed: string;
}

// ── Configurações e Estado Local ─────────────────────────────────────────
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// FIX V11.6.5: gemini-2.0-flash foi descontinuado no OpenRouter.
// Fallback atualizado para google/gemini-2.5-flash (modelo ativo mais rápido/barato).
const FALLBACK_MODEL = 'google/gemini-2.5-flash';
const CONCURRENCY_LIMIT = 3;

// Tarefas ativas: conjunto ordenado (membro = tarefa, score = hora de início).
// Cada tarefa se remove ao terminar; se a invocação morrer antes disso, o membro some
// sozinho depois de ACTIVE_STALE_MS (maior que o maior timeout: 25 s + 10 s do fallback).
const ACTIVE_KEY = 'llm_active_tasks';
const ACTIVE_STALE_MS = 90_000;
const ACTIVE_KEY_TTL_SECONDS = 300;

let localBreaker = { open: false, expires: 0 };

function edgeSafeHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ── Classe Principal ─────────────────────────────────────────────────────
class Gatekeeper {
  async isOverloaded(): Promise<boolean> {
    try {
      await redis.zremrangebyscore(ACTIVE_KEY, 0, Date.now() - ACTIVE_STALE_MS);
      const count = await redis.zcard(ACTIVE_KEY);
      return (count ?? 0) >= CONCURRENCY_LIMIT;
    } catch {
      return false;
    }
  }

  private async release(member: string): Promise<void> {
    await redis.zrem(ACTIVE_KEY, member).catch(() => {});
  }

  async enqueue(task: GatewayTask): Promise<LLMResponse> {
    const dedupKey = `llm_dedup:${task.id}:${edgeSafeHash(task.dedupPayload || '')}`;
    const member = `${task.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

    let cached: LLMResponse | null = null;
    let activeCount = 0;
    let redisAvailable = true;

    try {
      const now = Date.now();
      const results = (await redis.pipeline()
        .get(dedupKey)
        .zremrangebyscore(ACTIVE_KEY, 0, now - ACTIVE_STALE_MS)
        .zadd(ACTIVE_KEY, { score: now, member })
        .zcard(ACTIVE_KEY)
        .expire(ACTIVE_KEY, ACTIVE_KEY_TTL_SECONDS)
        .exec()) as unknown[];

      cached = (results[0] as LLMResponse | null) ?? null;
      activeCount = Number(results[3]) || 0; // já inclui esta tarefa
    } catch (error) {
      // Redis controla cache/concorrência, mas não é requisito para gerar a resposta.
      redisAvailable = false;
      console.warn('[Gateway] Redis indisponível; seguindo sem cache/limite global:', error);
    }

    if (cached) {
      if (redisAvailable) await this.release(member);
      const hit = cached as LLMResponse;
      return {
        ...hit,
        toolCalls: hit.toolCalls ?? null,
      };
    }

    try {
      const currentLoad = redisAvailable ? activeCount : 0;
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
      if (redisAvailable) await this.release(member);
    }
  }

  private async waitSmartly(ms: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const count = await redis.zcard(ACTIVE_KEY).catch(() => 99);
      if ((count || 0) <= CONCURRENCY_LIMIT) return;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  private async executeWithFallback(task: GatewayTask, dk: string): Promise<LLMResponse> {
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

    // ── Helper interno para chamar o modelo (com opção de desativar tools) ──
    const callModel = async (modelToCall: string, forceStripTools: boolean = false): Promise<LLMResponse> => {
      const isPro = modelToCall !== FALLBACK_MODEL;
      const timeout = isPro ? task.params.timeoutMs : task.params.timeoutMs + 10000;

      const hasTools = !forceStripTools && Array.isArray(task.params.tools) && task.params.tools.length > 0;

      // Limpeza estrita para evitar Erro 400
      let safeToolChoice: ToolChoice | undefined = forceStripTools ? undefined : task.params.toolChoice;
      if (!hasTools) {
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

      return {
        content: res.content || null,
        toolCalls: res.toolCalls || null,
        modelUsed: modelToCall
      };
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
      const errName = primaryError?.name || '';

      const is429     = primaryError?.status === 429 || errMsg.includes('429');
      const isTimeout = errMsg.includes('timeout') || errMsg.includes('aborted') || errName === 'AbortError';
      const is400     = primaryError?.status === 400 || errMsg.includes('400');
      // 404 = modelo inexistente/descontinuado → recuperável via fallback
      const is404     = primaryError?.status === 404 || errMsg.includes('404');

      // Só relança se for erro verdadeiramente não recuperável
      if (!is429 && !isTimeout && !is400 && !is404) {
        console.error(`[Gateway] Erro primário não recuperável:`, primaryError);
        throw primaryError;
      }

      if (is404) {
        console.warn(`[Gateway] Modelo "${activeModel}" não encontrado no OpenRouter (404). Forçando fallback imediato para ${FALLBACK_MODEL}.`);
      } else {
        console.warn(`[Gateway] Falha em ${activeModel} (${is429 ? '429' : is400 ? '400' : 'timeout'}). Iniciando cadeia de resgate.`);
      }

      // Circuit breaker abre apenas para problemas de rede (429/Timeout), não para 404/400
      if (is429 || isTimeout) {
        await redis.set('llm_circuit_breaker', 'open', { ex: 60 }).catch(() => {});
        localBreaker = { open: true, expires: Date.now() + 30000 };
      }

      // ── MODO SOBREVIVÊNCIA: já era fallback e deu 400 → problema no schema das tools ──
      if (activeModel === FALLBACK_MODEL && is400) {
        console.warn('[Gateway] Erro 400 no Fallback. Rejeição de Schema provável. Removendo tools e forçando texto livre.');
        try {
          return await callModel(FALLBACK_MODEL, true);
        } catch (survivalError) {
          console.error('[Gateway] Modo de sobrevivência falhou:', survivalError);
          return {
            content: 'Tive um problema técnico com minhas ferramentas agora. Pode me explicar de outra forma?',
            toolCalls: null,
            modelUsed: FALLBACK_MODEL,
          };
        }
      }

      // ── Proteção: 404 no próprio FALLBACK_MODEL → configuração errada ──────
      if (activeModel === FALLBACK_MODEL && is404) {
        console.error(`[Gateway] FALLBACK_MODEL "${FALLBACK_MODEL}" retornou 404. Verifique a constante FALLBACK_MODEL.`);
        return {
          content: 'Estou com um problema de configuração interna. Contate o suporte.',
          toolCalls: null,
          modelUsed: FALLBACK_MODEL,
        };
      }

      // ── TENTATIVA DE FALLBACK NORMAL ────────────────────────────────────────
      try {
        const fallbackRes = await callModel(FALLBACK_MODEL);
        if (!fallbackRes.toolCalls?.length) {
          await redis.set(dk, fallbackRes, { ex: 20 }).catch(() => {});
        }
        return fallbackRes;

      } catch (fallbackError: any) {
        const fbErrMsg    = fallbackError?.message?.toLowerCase() || '';
        const fbErrName   = fallbackError?.name || '';
        const fbIs400     = fallbackError?.status === 400 || fbErrMsg.includes('400');
        const fbIs404     = fallbackError?.status === 404 || fbErrMsg.includes('404');
        const fbIsTimeout = fbErrMsg.includes('timeout') || fbErrMsg.includes('aborted') || fbErrName === 'AbortError';

        // Fallback com 400 ou 404 → survival mode (strip tools)
        if (fbIs400 || fbIs404) {
          const reason = fbIs404
            ? `404 (modelo "${FALLBACK_MODEL}" não encontrado — atualize FALLBACK_MODEL)`
            : '400 (schema inválido)';
          console.warn(`[Gateway] Fallback secundário retornou ${reason}. Removendo tools e forçando texto livre.`);
          try {
            return await callModel(FALLBACK_MODEL, true);
          } catch (survivalError2) {
            console.error('[Gateway] Modo de sobrevivência 2 falhou:', survivalError2);
            return {
              content: 'Tive um problema técnico com minhas ferramentas agora. Pode me explicar de outra forma?',
              toolCalls: null,
              modelUsed: FALLBACK_MODEL,
            };
          }
        }

        console.error(`[Gateway] Fallback falhou definitivamente (${fbIsTimeout ? 'Timeout' : 'Rede'}):`, fallbackError?.message || fallbackError);
        return {
          content: 'Estou com muita dificuldade de conexão neste exato momento. Tente novamente em alguns segundos.',
          toolCalls: null,
          modelUsed: FALLBACK_MODEL,
        };
      }
    }
  }
}

export const llmGateway = new Gatekeeper();

// ── Wrapper Exportado ────────────────────────────────────────────────────
export async function callOpenRouterWithPriority(
  priority: 1 | 2 | 3 | 4,
  dropPolicy: string,
  taskId: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  model: string,
  temperature: number,
  timeoutMs: number = 25000,
  maxTokens?: number,
  toolChoice?: ToolChoice
): Promise<LLMResponse> {
  return llmGateway.enqueue({
    id: taskId,
    priority,
    params: { messages, tools, model, temperature, timeoutMs, maxTokens, toolChoice },
    dedupPayload: JSON.stringify({ messages, model, tools }),
  });
}
