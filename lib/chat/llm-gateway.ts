import OpenAI from 'openai';
import type { ChatMessage, LLMResponse } from './pipeline/llm-orchestrator';

const WARMUP_MIN_INTERVAL_MS = 4 * 60 * 1000;
const WARMUP_TIMEOUT_MS = 20 * 1000;
let lastWarmupAt = 0;

// ── Orçamento de tempo da chamada à Modal ───────────────────────────────────
// A rota de chat tem maxDuration = 60 s e o fallback (OpenRouter) pode gastar até 15 s.
// Modal + eventual retry precisam terminar em 35 s no total, senão a Vercel mata a
// função antes de o Gemini conseguir responder.
const MODAL_REQUEST_TIMEOUT_MS = 30 * 1000;
const MODAL_TOTAL_BUDGET_MS = 35 * 1000;
const MODAL_MIN_RETRY_BUDGET_MS = 10 * 1000;

// ── Status da Modal (usado pela rota /api/lev/warmup) ───────────────────────
// Long-poll: segura a requisição até a Modal responder ou até 25 s. Enquanto o cold
// start roda, essa requisição pendente também mantém a demanda que sobe o container.
const STATUS_LONG_POLL_MS = 25 * 1000;
const STATUS_MIN_SPACING_MS = 3 * 1000;

export type LevStatus = 'ready' | 'warming' | 'auth_error' | 'error' | 'not_configured';

function modalBaseUrl(): string | null {
  const baseUrl = process.env.MODAL_API_URL?.trim();
  return baseUrl ? baseUrl.replace(/\/$/, '') : null;
}

/**
 * Pergunta à Modal se ela está pronta (e, se estiver desligada, ajuda a acordá-la).
 *  - ready:          respondeu 200
 *  - warming:        timeout ou 5xx (container subindo)
 *  - auth_error:     401/403 (MODAL_API_KEY diferente da --api-key do vLLM)
 *  - error:          qualquer outro status (ex.: 404, URL errada)
 *  - not_configured: MODAL_API_URL ausente (o chat usa o fallback direto)
 */
export async function getLevStatus(): Promise<LevStatus> {
  const baseUrl = modalBaseUrl();
  if (!baseUrl) return 'not_configured';

  const startedAt = Date.now();
  let status: LevStatus;

  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${process.env.MODAL_API_KEY}` },
      signal: AbortSignal.timeout(STATUS_LONG_POLL_MS),
      cache: 'no-store',
    });
    if (response.ok) status = 'ready';
    else if (response.status === 401 || response.status === 403) status = 'auth_error';
    else status = response.status >= 500 ? 'warming' : 'error';
  } catch {
    // Timeout do long-poll (cold start ainda em andamento) ou falha de rede.
    status = 'warming';
  }

  // Falha rápida durante o boot: espera um pouco para o app não martelar a rota.
  if (status === 'warming') {
    const elapsed = Date.now() - startedAt;
    if (elapsed < STATUS_MIN_SPACING_MS) {
      await new Promise((resolve) => setTimeout(resolve, STATUS_MIN_SPACING_MS - elapsed));
    }
  }

  console.log(`[Lev Gateway] Status da Modal: ${status} (${Date.now() - startedAt}ms)`);
  return status;
}

/** Acorda a Modal sem manter a requisição de chat aberta. */
export async function warmUpLev(): Promise<void> {
  const baseUrl = modalBaseUrl();
  if (!baseUrl) return;

  const now = Date.now();
  if (now - lastWarmupAt < WARMUP_MIN_INTERVAL_MS) return;
  lastWarmupAt = now;

  try {
    await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${process.env.MODAL_API_KEY}` },
      signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
    });
  } catch {
    // Warm-up é oportunista; a chamada principal continua responsável pelo retry.
  }
}

async function pingModal(timeoutMs: number = WARMUP_TIMEOUT_MS): Promise<boolean> {
  const baseUrl = modalBaseUrl();
  if (!baseUrl) return false;

  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${process.env.MODAL_API_KEY}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function shouldRetryModal(error: any): boolean {
  const status = error?.status ?? error?.statusCode;
  return status === 502 || status === 503 || status === 504 || error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT';
}

// ── Orçamento de contexto ────────────────────────────────────────────────────
// O vLLM rejeita com 400 quando prompt + max_tokens > --max-model-len (ver lev_modal.py).
// Estimamos o prompt de forma conservadora e: (1) reduzimos max_tokens para caber;
// (2) se nem o mínimo cabe, não gastamos uma chamada que certamente dá 400 — lançamos
// erro para o orquestrador cair direto no fallback.
const MODAL_MAX_MODEL_LEN = Number(process.env.MODAL_MAX_MODEL_LEN) || 4096;
const MAX_OUTPUT_TOKENS = 512;
const MIN_OUTPUT_TOKENS = 128;
const CONTEXT_SAFETY_MARGIN = 128;
const CHARS_PER_TOKEN = 3; // conservador para português + JSON de tools

function estimatePromptTokens(messages: ChatMessage[], tools: any[]): number {
  const chars = JSON.stringify(messages).length + (tools?.length ? JSON.stringify(tools).length : 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// Quantas mensagens finais nunca são removidas (pergunta atual + contexto imediato / cadeia de tools).
const MIN_MESSAGES_KEPT = 4;

/**
 * Remove as mensagens mais antigas (logo após o system) até o prompt caber no orçamento.
 * Nunca mexe no system nem nas últimas MIN_MESSAGES_KEPT e não deixa uma mensagem `tool` órfã.
 */
function trimHistoryToFit(messages: ChatMessage[], tools: any[], maxPromptTokens: number): ChatMessage[] {
  if (estimatePromptTokens(messages, tools) <= maxPromptTokens) return messages;

  const trimmed = [...messages];
  const hasSystem = trimmed[0]?.role === 'system';
  const firstDroppable = hasSystem ? 1 : 0;

  while (
    estimatePromptTokens(trimmed, tools) > maxPromptTokens &&
    trimmed.length - firstDroppable > MIN_MESSAGES_KEPT
  ) {
    trimmed.splice(firstDroppable, 1);
  }
  // Removeu a mensagem do assistente que tinha tool_calls? Descarta os resultados que sobraram.
  while (trimmed.length - firstDroppable > 1 && trimmed[firstDroppable]?.role === 'tool') {
    trimmed.splice(firstDroppable, 1);
  }
  return trimmed;
}

function getModalClient(): OpenAI {
  const baseURL = process.env.MODAL_API_URL?.trim();
  if (!baseURL) {
    throw new Error('MODAL_API_URL não configurada; usando o fallback OpenRouter.');
  }

  return new OpenAI({
    baseURL: baseURL.replace(/\/$/, ''),
    apiKey: process.env.MODAL_API_KEY || 'modal-key-not-configured',
    // Teto por requisição; o tempo real de cada tentativa é limitado pelo orçamento total.
    timeout: MODAL_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  });
}

export async function callLevModel(
  messages: ChatMessage[],
  tools: any[],
  temperature: number = 0.7,
  toolChoice: 'auto' | 'required' = 'auto',
): Promise<LLMResponse> {
  let requestMessages = messages;
  const startedAt = Date.now();
  const remainingMs = () => MODAL_TOTAL_BUDGET_MS - (Date.now() - startedAt);

  try {
    const hasTools = tools && tools.length > 0;

    // Garante espaço para a resposta inteira: apara o histórico antigo se preciso.
    requestMessages = trimHistoryToFit(
      messages,
      tools,
      MODAL_MAX_MODEL_LEN - MAX_OUTPUT_TOKENS - CONTEXT_SAFETY_MARGIN,
    );
    if (estimatePromptTokens(requestMessages, tools) > MODAL_MAX_MODEL_LEN - MIN_OUTPUT_TOKENS - CONTEXT_SAFETY_MARGIN) {
      throw new Error('Prompt excede o orçamento mínimo de contexto da Modal; usando fallback.');
    }
    const promptTokens = estimatePromptTokens(requestMessages, tools);
    const available = MODAL_MAX_MODEL_LEN - promptTokens - CONTEXT_SAFETY_MARGIN;
    if (process.env.NODE_ENV !== 'production') {
      console.debug(
        `[Lev Gateway] Prompt ~${promptTokens} tokens | tools: ${hasTools ? tools.length : 0} | msgs: ${requestMessages.length}/${messages.length} | espaço p/ resposta: ${available}`,
      );
    }
    if (available < MIN_OUTPUT_TOKENS) {
      throw new Error(
        `Prompt estimado em ~${promptTokens} tokens não cabe no contexto da Modal (${MODAL_MAX_MODEL_LEN}); usando fallback.`,
      );
    }
    const maxTokens = Math.min(MAX_OUTPUT_TOKENS, available);

    const request = (timeoutMs: number) => getModalClient().chat.completions.create(
      {
        model: 'celioNascimento/Lev-LoRA-Orquestrador-Merged-v2',
        messages: requestMessages as any,
        tools: hasTools ? tools : undefined,
        // Alguns servidores vLLM/Modal rejeitam explicitamente tool_choice=auto.
        tool_choice: hasTools && toolChoice === 'required' ? 'required' : undefined,
        temperature,
        max_tokens: maxTokens,
      },
      { timeout: timeoutMs },
    );

    let response;
    try {
      response = await request(Math.min(MODAL_REQUEST_TIMEOUT_MS, remainingMs()));
    } catch (error) {
      // Cold starts e reinícios da Modal podem retornar 502/503/504. Nesse caso,
      // confirma que o endpoint voltou e tenta uma única vez, sem loop infinito e
      // sem estourar o orçamento de tempo da rota de chat.
      if (!shouldRetryModal(error)) throw error;
      if (remainingMs() < MODAL_MIN_RETRY_BUDGET_MS) throw error;
      if (!(await pingModal(Math.min(8_000, remainingMs() - 5_000)))) throw error;
      if (remainingMs() < 5_000) throw error;
      response = await request(remainingMs());
    }

    const choice = response.choices[0].message;
    return {
      content: choice.content || '',
      toolCalls: (choice.tool_calls as any) || undefined,
      modelUsed: 'lev-modal-vllm',
    };
  } catch (error: any) {
    // Sempre loga: timeouts e falhas locais não têm status/code e antes passavam em silêncio.
    const status = error?.status ?? error?.statusCode ?? 'unknown';
    const code = error?.code ?? 'unknown';
    const reason = String(error?.message ?? '').slice(0, 200);
    console.error(`[Lev Gateway] Modal request failed: status=${status} code=${code} reason="${reason}"`);

    throw error; // Repassa o erro para o fallback do Orquestrador
  }
}
