// lib/chat/lev-gateway.ts
import OpenAI from 'openai';
import type { ChatMessage, LLMResponse } from './pipeline/llm-orchestrator';

const MODEL_NAME = 'celioNascimento/Lev-LoRA-Orquestrador-Merged';
const MAX_OUTPUT_TOKENS = 512;

// Conversa solta pode ser mais criativa; passos que decidem/geram tool_call precisam de
// menos aleatoriedade para não errar a ferramenta ou o JSON dos argumentos.
export const CHAT_TEMPERATURE = 0.8;
export const TOOL_TEMPERATURE = 0.3;

// ── Warm-up do Modal ─────────────────────────────────────────────────────────
// O container do vLLM desliga quando fica ocioso (scaledown_window). Qualquer requisição HTTP
// o acorda, e cada requisição reinicia o contador de ociosidade. Chamamos isto quando o app
// abre (junto com clima etc.) para que o modelo já esteja subindo antes da primeira mensagem.

const WARMUP_MIN_INTERVAL_MS = 4 * 60 * 1000; // não repetir o ping dentro de 4 min (por instância)
// Só precisamos "bater na porta" para o Modal começar a subir o container; não vale ficar
// segurando a função serverless durante todo o cold start.
const WARMUP_TIMEOUT_MS = 20 * 1000;
let lastWarmupAt = 0;

export async function warmUpLev(): Promise<void> {
  const baseUrl = process.env.MODAL_API_URL;
  if (!baseUrl) return;

  const now = Date.now();
  if (now - lastWarmupAt < WARMUP_MIN_INTERVAL_MS) return;
  lastWarmupAt = now;

  try {
    // GET /models é leve (não gera tokens) e só responde quando o vLLM está de pé.
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${process.env.MODAL_API_KEY}` },
      signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
    });
    console.log(`[Lev Gateway] Warm-up do Modal: HTTP ${res.status} em ${Date.now() - now}ms`);
  } catch (err: any) {
    // Timeout/erro aqui não é grave: o container pode ainda estar subindo.
    console.warn('[Lev Gateway] Warm-up do Modal não confirmou:', err?.message ?? err);
  }
}

const modalClient = new OpenAI({
  baseURL: process.env.MODAL_API_URL,
  apiKey: process.env.MODAL_API_KEY,
});

export async function callLevModel(
  messages: ChatMessage[],
  tools: any[],
  temperature: number = CHAT_TEMPERATURE,
  toolChoice: 'auto' | 'required' = 'auto'
): Promise<LLMResponse> {
  try {
    const hasTools = tools && tools.length > 0;

    // LOG: Verificar o que está sendo enviado (tokens estimados ≈ chars / 3)
    const payloadChars = JSON.stringify({ messages, tools: hasTools ? tools : [] }).length;
    console.log(
      `[Lev Gateway] Enviando para Modal. Tools: ${hasTools ? tools.length : 0} | Msgs: ${messages.length} | ~${Math.round(payloadChars / 3)} tokens de prompt`
    );

    const response = await modalClient.chat.completions.create({
      model: MODEL_NAME,
      messages: messages as any,
      tools: hasTools ? tools : undefined,
      tool_choice: hasTools ? 'auto' : undefined, // vLLM exige 'auto' ou objeto explícito
      temperature: temperature,
      top_p: 0.9,
      // O servidor roda com --max-model-len 8192 (prompt + saída). As respostas do Lev são curtas,
      // então reservar 2000 de saída só desperdiçava contexto e causava 400.
      max_tokens: MAX_OUTPUT_TOKENS,
    });

    const choice = response.choices[0].message;
    return {
      content: choice.content,
      toolCalls: (choice.tool_calls as any) || undefined,
      modelUsed: 'lev-modal-vllm',
    };
  } catch (error: any) {
    console.error('[Lev Gateway] Erro na chamada da Modal:', error.message);
    // LOG 2: Ver a resposta exata do vLLM
    if (error.error) {
      console.error('[Lev Gateway] Detalhes do vLLM:', JSON.stringify(error.error, null, 2));
    } else if (error.status === 400) {
      // O vLLM devolve {"object":"error","message":...}, formato que o SDK não extrai.
      // Repete a chamada crua só para registrar a mensagem real do 400.
      try {
        const raw = await fetch(`${process.env.MODAL_API_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.MODAL_API_KEY}`,
          },
          body: JSON.stringify({
            model: MODEL_NAME,
            messages,
            tools: tools && tools.length > 0 ? tools : undefined,
            tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
            temperature,
            max_tokens: MAX_OUTPUT_TOKENS,
          }),
        });
        console.error('[Lev Gateway] Corpo bruto do 400:', await raw.text());
      } catch (diagErr) {
        console.error('[Lev Gateway] Falha ao obter corpo bruto do 400:', diagErr);
      }
    }
    throw error;
  }
}