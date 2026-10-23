import OpenAI from 'openai';
import type { ChatMessage, LLMResponse } from './pipeline/llm-orchestrator';

const WARMUP_MIN_INTERVAL_MS = 4 * 60 * 1000;
const WARMUP_TIMEOUT_MS = 20 * 1000;
let lastWarmupAt = 0;

function modalBaseUrl(): string | null {
  const baseUrl = process.env.MODAL_API_URL?.trim();
  return baseUrl ? baseUrl.replace(/\/$/, '') : null;
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

async function pingModal(): Promise<boolean> {
  const baseUrl = modalBaseUrl();
  if (!baseUrl) return false;

  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${process.env.MODAL_API_KEY}` },
      signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
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
const MIN_PROMPT_TOKENS = 256;
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
  });
}

export async function callLevModel(
  messages: ChatMessage[],
  tools: any[],
  temperature: number = 0.7,
  toolChoice: 'auto' | 'required' = 'auto',
): Promise<LLMResponse> {
  let requestMessages = messages;
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

    const request = () => getModalClient().chat.completions.create({
      model: 'celioNascimento/Lev-LoRA-Orquestrador-Merged',
      messages: requestMessages as any,
      tools: hasTools ? tools : undefined,
      // Alguns servidores vLLM/Modal rejeitam explicitamente tool_choice=auto.
      tool_choice: hasTools && toolChoice === 'required' ? 'required' : undefined,
      temperature,
      max_tokens: maxTokens,
    });

    let response;
    try {
      response = await request();
    } catch (error) {
      // Cold starts e reinícios da Modal podem retornar 502/503/504. Nesse caso,
      // confirma que o endpoint voltou e tenta uma única vez, sem loop infinito.
      if (!shouldRetryModal(error)) throw error;
      if (!(await pingModal())) throw error;
      response = await request();
    }

    const choice = response.choices[0].message;
    return {
      content: choice.content || '',
      toolCalls: (choice.tool_calls as any) || undefined,
      modelUsed: 'lev-modal-vllm',
    };
  } catch (error: any) {
    const status = error?.status ?? error?.statusCode ?? 'unknown';
    const code = error?.code ?? 'unknown';
    console.error(`[Lev Gateway] Modal request failed: status=${status} code=${code}`);

    throw error; // Repassa o erro para o fallback do Orquestrador
  }
}
