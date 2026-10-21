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
    const hasTools = tools && tools.length > 0;

    // LOG: Verificar o que está sendo enviado
    console.log(`[Lev Gateway] Enviando para Modal. Tools: ${hasTools ? tools.length : 0} | Msgs: ${messages.length}`);

    const response = await modalClient.chat.completions.create({
      model: 'celioNascimento/Lev-LoRA-Orquestrador-Merged',
      messages: messages as any,
      tools: hasTools ? tools : undefined,
      tool_choice: hasTools ? 'auto' : undefined, // vLLM exige 'auto' ou objeto explícito
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