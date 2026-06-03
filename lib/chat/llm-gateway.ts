// lib/chat/llm-gateway.ts
// V11.6.4 — Correção do ID do Modelo Flash + Tratamento de Erro 404

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

// FIX V11.6.4: Modelo correto sem sufixo -001 (não existe no OpenRouter)
const FALLBACK_MODEL = 'google/gemini-2.0-flash';
const CONCURRENCY_LIMIT = 3;

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
      const count = await redis.get<number>('global_llm_active');
      return (count ?? 0) >= CONCURRENCY_LIMIT;
    } catch {
      return false;
    }
  }

  async enqueue(task: GatewayTask): Promise<LLMResponse> {
    const dedupKey = `llm_dedup:${task.id}:${edgeSafeHash(task.dedupPayload || '')}`;

    const [cached, activeCount] = await redis.pipeline()
      .get(dedupKey)
      .incr('global_llm_active')
      .exec();

    if (cached) {
      await redis.decr('global_llm_active');
      const hit = cached as LLMResponse;
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
      // FIX V11.6.4: 404 agora é recuperável — modelo inexistente → tenta fallback
      const is404     = primaryError?.status === 404 || errMsg.includes('404');

      // Só relança se for erro verdadeiramente não recuperável
      if (!is429 && !isTimeout && !is400 && !is404) {
        console.error(`[Gateway] Erro primário não recuperável:`, primaryError);
        throw primaryError;
      }

      if (is404) {
        console.warn(`[Gateway] Modelo "${activeModel}" não encontrado no OpenRouter (404). Forçando fallback imediato.`);
      } else {
        console.warn(`[Gateway] Falha em ${activeModel} (${is429 ? '429' : is400 ? '400' : 'timeout'}). Iniciando cadeia de resgate.`);
      }

      // Circuit breaker abre apenas para problemas de rede (429/Timeout), não para 404/400
      if (is429 || isTimeout) {
        await redis.set('llm_circuit_breaker', 'open', { ex: 60 }).catch(() => {});
        localBreaker = { open: true, expires: Date.now() + 30000 };
      }

      // ── MODO SOBREVIVÊNCIA: Fallback com 400 → problema no schema das tools ──
      if (activeModel === FALLBACK_MODEL && is400) {
        console.warn('[Gateway] Erro 400 no Fallback. Rejeição de Schema provável. Removendo tools e forçando texto livre.');
        try {
          return await callModel(FALLBACK_MODEL, true);
        } catch (survivalError) {
          console.error('[Gateway] Modo de sobrevivência falhou:', survivalError);
          return {
            content: 'Tive um problema técnico complexo com minhas ferramentas agora. Pode me explicar de outra forma?',
            toolCalls: null,
            modelUsed: FALLBACK_MODEL,
          };
        }
      }

      // ── TENTATIVA DE FALLBACK NORMAL ────────────────────────────────────────
      // Se o erro foi 404 no próprio fallback, vai direto para survival mode
      if (activeModel === FALLBACK_MODEL && is404) {
        console.error('[Gateway] FALLBACK_MODEL também retornou 404. Verifique a constante FALLBACK_MODEL.');
        return {
          content: 'Estou com um problema de configuração interna. Contate o suporte.',
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
        const fbErrMsg  = fallbackError?.message?.toLowerCase() || '';
        const fbErrName = fallbackError?.name || '';
        const fbIs400   = fallbackError?.status === 400 || fbErrMsg.includes('400');
        const fbIs404   = fallbackError?.status === 404 || fbErrMsg.includes('404');
        const fbIsTimeout = fbErrMsg.includes('timeout') || fbErrMsg.includes('aborted') || fbErrName === 'AbortError';

        // Fallback com 400 ou 404 → survival mode (strip tools)
        if (fbIs400 || fbIs404) {
          const reason = fbIs404 ? '404 (modelo não encontrado)' : '400 (schema inválido)';
          console.warn(`[Gateway] Fallback secundário retornou ${reason}. Removendo tools e forçando texto livre.`);
          try {
            return await callModel(FALLBACK_MODEL, true);
          } catch (survivalError2) {
            console.error('[Gateway] Modo de sobrevivência 2 falhou:', survivalError2);
            return {
              content: 'Tive um problema técnico complexo com minhas ferramentas agora. Pode me explicar de outra forma?',
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
