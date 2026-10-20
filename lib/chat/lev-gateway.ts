// lib/chat/lev-gateway.ts
import OpenAI from 'openai';
import type { ChatMessage, LLMResponse } from './pipeline/llm-orchestrator';

// O Qwen2.5 é compatível com a API da OpenAI, então usamos o SDK oficial
const hfClient = new OpenAI({
  baseURL: 'https://router.huggingface.co/v1',
  apiKey: process.env.HF_TOKEN,
});

export async function callLevModel(
  messages: ChatMessage[],
  tools: any[],
  temperature: number = 0.7
): Promise<LLMResponse> {
  try {
    const response = await hfClient.chat.completions.create({
      model: process.env.HF_MODEL_ID as string,
      messages: messages as any,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      temperature: temperature,
      max_tokens: 1500,
    });

    const choice = response.choices[0].message;

    return {
      content: choice.content,
      toolCalls: choice.tool_calls as any,
      modelUsed: process.env.HF_MODEL_ID as string,
    };
  } catch (error) {
    console.error('[Lev Gateway] Erro na chamada do HF:', error);
    throw error;
  }
}
