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
    // LOG 1: Ver o que estamos enviando
    console.log('[Lev Gateway] Enviando para Modal:', JSON.stringify({
      model: 'celioNascimento/Lev-LoRA-Orquestrador-Merged',
      messages: messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      tool_choice: tools && tools.length > 0 ? toolChoice : undefined,
    }, null, 2));

    const response = await modalClient.chat.completions.create({
      model: 'celioNascimento/Lev-LoRA-Orquestrador-Merged',
      messages: messages as any,
      tools: tools && tools.length > 0 ? tools : undefined,
      // Vamos forçar o 'auto' para testar se o problema é o 'required'
      tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
      temperature: temperature,
      max_tokens: 2000,
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
    }
    throw error;
  }
}