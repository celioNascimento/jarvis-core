// lib/chat/lev-gateway.ts
import OpenAI from 'openai';
import type { ChatMessage, LLMResponse } from './pipeline/llm-orchestrator';

const hfClient = new OpenAI({
  baseURL: 'https://router.huggingface.co/v1',
  apiKey: process.env.HF_TOKEN,
});

// A assinatura abaixo aceita 4 argumentos. O TypeScript exige que todos os tipos batam.
export async function callLevModel(
  messages: ChatMessage[],
  tools: any[],
  temperature: number = 0.7,
  toolChoice: 'auto' | 'required' = 'auto' // <-- Este é o 4º argumento
): Promise<LLMResponse> {
  try {
    const response = await hfClient.chat.completions.create({
      model: process.env.HF_MODEL_ID as string,
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
      modelUsed: process.env.HF_MODEL_ID as string,
    };
  } catch (error) {
    console.error('[Lev Gateway] Erro na chamada do HF:', error);
    throw error;
  }
}
