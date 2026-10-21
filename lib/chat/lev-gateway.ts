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
  try {
    const hasTools = tools && tools.length > 0;
    const response = await getModalClient().chat.completions.create({
      model: 'celioNascimento/Lev-LoRA-Orquestrador-Merged',
      messages: messages as any,
      tools: hasTools ? tools : undefined,
      // Alguns servidores vLLM/Modal rejeitam explicitamente tool_choice=auto.
      // O comportamento padrão da API já é automático quando o campo é omitido.
      tool_choice: hasTools && toolChoice === 'required' ? 'required' : undefined,
      temperature: temperature,
      max_tokens: 2000,
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
    throw error; // Repassa o erro para o fallback do Orquestrador
  }
}
