// lib/chat/lev-gateway.ts
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
  toolChoice: 'auto' | 'required' = 'auto'
): Promise<LLMResponse> {
  try {
    const response = await modalClient.chat.completions.create({
      model: 'celioNascimento/Lev-LoRA-Orquestrador-Merged',
      messages: messages as any,
      tools: tools && tools.length > 0 ? tools : undefined,
      tool_choice: tools && tools.length > 0 ? toolChoice : undefined,
      temperature: temperature,
      max_tokens: 2000,
    });

    const choice = response.choices[0].message;

    return {
      content: choice.content,
      toolCalls: (choice.tool_calls as any) || undefined,
      modelUsed: 'lev-modal-vllm',
    };
  } catch (error) {
    console.error('[Lev Gateway] Erro na chamada da Modal:', error);
    throw error;
  }
}