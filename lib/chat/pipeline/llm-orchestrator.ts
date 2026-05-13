// lib/chat/pipeline/llm-orchestrator.ts
// Fase 4 — Ciclo LLM + Tool Loop

import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway';
import { executeTool } from '@/lib/chat/tools-executor';
import type { ChatRequestContext } from './request-context';
import type { ChatPrompt } from './prompt-assembler';

interface ToolCallResult {
  tc: any;
  result: string;
}

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

export async function runLLMOrchestrator(
  ctx: ChatRequestContext,
  prompt: ChatPrompt
): Promise<string> {
  const { user, requestSignature } = ctx;
  const { conversationMessages, tools, model } = prompt;
  const contextSnapshot = conversationMessages.slice(-3);

  // ── Primeira chamada (Direto para o Gateway) ─────────────────────────────
  const firstResponse = await callOpenRouterWithPriority(
    1, // PriorityLevel (Tipagem corrigida no Gateway)
    'never',
    requestSignature,
    conversationMessages,
    tools,
    model,
    0.7
  );

  if (!firstResponse.toolCalls?.length) {
    return firstResponse.content || 'Entendido.';
  }

  // ── Tool loop ─────────────────────────────────────────────────────────────
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

  // ── Segunda chamada (Síntese) ─────────────────────────────────────────────
  const secondResponse = await callOpenRouterWithPriority(
    1,
    'never',
    `${requestSignature}_synth`,
    [...conversationMessages, ...toolMessages],
    [],
    model,
    0.7
  );

  return secondResponse.content || 'Entendido.';
}
