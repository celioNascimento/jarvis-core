import OpenAI from 'openai';
import type { ChatMessage, LLMResponse } from './pipeline/llm-orchestrator';

const WARMUP_MIN_INTERVAL_MS = 4 * 60 * 1000;
const WARMUP_TIMEOUT_MS = 20 * 1000;
let lastWarmupAt = 0;

/** Wakes the Modal container without blocking the first chat response. */
export async function warmUpLev(): Promise<void> {
  const baseUrl = process.env.MODAL_API_URL;
  if (!baseUrl) return;

  const now = Date.now();
  if (now - lastWarmupAt < WARMUP_MIN_INTERVAL_MS) return;
  lastWarmupAt = now;

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${process.env.MODAL_API_KEY}` },
      signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
    });
    console.log(`[Lev Gateway] Warm-up do Modal: HTTP ${response.status}`);
  } catch (error) {
    console.warn('[Lev Gateway] Warm-up do Modal não confirmou:', error);
  }
}

// ── Orçamento de contexto ────────────────────────────────────────────────────
// O vLLM rejeita com 400 quando prompt + max_tokens > --max-model-len (ver lev_modal.py).
// Estimamos o prompt de forma conservadora e: (1) reduzimos max_tokens para caber;
// (2) se nem o mínimo cabe, não gastamos uma chamada que certamente dá 400 — lançamos
// erro para o orquestrador cair direto no fallback.
const MODAL_MAX_MODEL_LEN = Number(process.env.MODAL_MAX_MODEL_LEN) || 8192;
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
    const promptTokens = estimatePromptTokens(requestMessages, tools);
    const available = MODAL_MAX_MODEL_LEN - promptTokens - CONTEXT_SAFETY_MARGIN;
    console.log(
      `[Lev Gateway] Prompt ~${promptTokens} tokens | tools: ${hasTools ? tools.length : 0} | msgs: ${requestMessages.length}/${messages.length} | espaço p/ resposta: ${available}`,
    );
    if (available < MIN_OUTPUT_TOKENS) {
      throw new Error(
        `Prompt estimado em ~${promptTokens} tokens não cabe no contexto da Modal (${MODAL_MAX_MODEL_LEN}); usando fallback.`,
      );
    }
    const maxTokens = Math.min(MAX_OUTPUT_TOKENS, available);

    const response = await getModalClient().chat.completions.create({
      model: 'celioNascimento/Lev-LoRA-Orquestrador-Merged',
      messages: requestMessages as any,
      tools: hasTools ? tools : undefined,
      // Alguns servidores vLLM/Modal rejeitam explicitamente tool_choice=auto.
      // O comportamento padrão da API já é automático quando o campo é omitido.
      tool_choice: hasTools && toolChoice === 'required' ? 'required' : undefined,
      temperature: temperature,
      max_tokens: maxTokens,
    });

    const choice = response.choices[0].message;
    return {
      content: choice.content || "", // vLLM safe
      toolCalls: (choice.tool_calls as any) || undefined,
      modelUsed: 'lev-modal-vllm',
    };
  } catch (error: any) {
    const status = error?.status ?? error?.statusCode ?? 'desconhecido';
    const body = error?.error?.message || error?.response?.data?.error?.message || error?.message || 'sem detalhes';
    console.error(`[Lev Gateway] Erro na Modal: HTTP ${status} — ${body}`);

    // O vLLM devolve {"object":"error","message":...}, formato que o SDK da OpenAI não extrai
    // ("400 status code (no body)"). Repete a chamada crua só para registrar a causa real.
    if (status === 400) {
      try {
        const raw = await fetch(`${process.env.MODAL_API_URL?.trim().replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.MODAL_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'celioNascimento/Lev-LoRA-Orquestrador-Merged',
            messages: requestMessages,
            tools: tools && tools.length > 0 ? tools : undefined,
            temperature,
            max_tokens: MIN_OUTPUT_TOKENS,
          }),
          signal: AbortSignal.timeout(15000),
        });
        console.error('[Lev Gateway] Corpo bruto do 400:', (await raw.text()).slice(0, 1000));
      } catch (diagErr) {
        console.error('[Lev Gateway] Falha ao obter corpo bruto do 400:', diagErr);
      }
    }

    throw error; // Repassa o erro para o fallback do Orquestrador
  }
}
