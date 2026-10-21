import OpenAI from 'openai';
import type { ChatMessage, LLMResponse } from './pipeline/llm-orchestrator';

const modalClient = new OpenAI({
  baseURL: process.env.MODAL_API_URL,
  apiKey: process.env.MODAL_API_KEY,
});

export async function callLevModel(
  messages: ChatMessage[],
  tools: any[],
  temperature: number = 0.7,
): Promise<LLMResponse> {
  try {
    const hasTools = tools && tools.length > 0;
    const response = await modalClient.chat.completions.create({
      model: 'celioNascimento/Lev-LoRA-Orquestrador-Merged',
      messages: messages as any,
      tools: hasTools ? tools : undefined,
      tool_choice: hasTools ? 'auto' : undefined,
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
    console.error('[Lev Gateway] Erro na Modal:', error.message);
    throw error; // Repassa o erro para o fallback do Orquestrador
  }
}
