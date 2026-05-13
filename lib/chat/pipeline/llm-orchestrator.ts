// lib/chat/pipeline/llm-orchestrator.ts
// Fase 4 — Ciclo LLM + Tool Loop

import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway';
import { executeTool } from '@/lib/chat/tools-executor';
import type { ChatRequestContext } from './request-context';
import type { ChatPrompt } from './prompt-assembler';

// ─── Tipos Internos ───────────────────────────────────────────────────────────

interface ToolCallResult {
  tc: any;
  result: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function executeToolCalls(
  toolCalls: any[],
  authUserId: string,
  numericUserId: string,
  contextSnapshot: Record<string, any>[]
): Promise<ToolCallResult[]> {
  return Promise.all(
    toolCalls.map(async (tc: any) => ({
      tc,
      result: await executeTool(tc, authUserId, numericUserId, contextSnapshot),
    }))
  );
}

function buildToolCallMessages(
  firstContent: string | null,
  toolCalls: any[],
  toolResults: ToolCallResult[]
): any[] {
  return [
    {
      role: 'assistant',
      content: firstContent || null,
      tool_calls: toolCalls.map((tc: any) => ({
        id:       tc.id,
        type:     'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    },
    ...toolResults.map((tr: any) => ({
      role:         'tool',
      tool_call_id: tr.tc.id,
      content:      typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
    })),
  ];
}

function appendResilienceNotice(text: string, requestedModel: string, usedModel: string): string {
  // Só adiciona a nota se o usuário pediu o PRO e o sistema entregou o FLASH (fallback)
  const isFallback = requestedModel.includes('pro') && usedModel.includes('flash');
  
  if (!isFallback) return text;
  
  const notice = `\n\n---\n*💡 Nota: O motor principal (Pro) está instável. Resposta gerada via motor de reserva (Flash).*`;
  return text + notice;
}

// ─── Entrypoint Único ─────────────────────────────────────────────────────────

export async function runLLMOrchestrator(
  ctx: ChatRequestContext,
  prompt: ChatPrompt
): Promise<string> {
  const { user, requestSignature } = ctx;
  const { conversationMessages, tools, model: requestedModel } = prompt;
  const contextSnapshot = conversationMessages.slice(-3);

  // 1. Primeira chamada ao Gateway
  const firstResponse = await callOpenRouterWithPriority(
    1,
    'never',
    requestSignature,
    conversationMessages,
    tools,
    requestedModel,
    0.7
  );

  // Se não houve tool calls, tratamos a resposta direta
  if (!firstResponse.toolCalls?.length) {
    const content = firstResponse.content || 'Entendido.';
    return appendResilienceNotice(content, requestedModel, firstResponse.modelUsed || requestedModel);
  }

  // 2. Tool loop (Execução das ferramentas)
  const toolResults = await executeToolCalls(
    firstResponse.toolCalls,
    user.auth_user_id,
    String(user.id),
    contextSnapshot
  );

  const toolMessages = buildToolCallMessages(
    firstResponse.content,
    firstResponse.toolCalls,
    toolResults
  );

  // 3. Segunda chamada (Síntese final)
  const secondResponse = await callOpenRouterWithPriority(
    1,
    'never',
    `${requestSignature}_synth`,
    [...conversationMessages, ...toolMessages],
    [],
    requestedModel,
    0.7
  );

  const finalContent = secondResponse.content || 'Entendido.';

  // Retorna o conteúdo com a nota apenas se houve troca forçada de modelo
  return appendResilienceNotice(
    finalContent, 
    requestedModel, 
    secondResponse.modelUsed || requestedModel
  );
}
