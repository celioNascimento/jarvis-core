// lib/chat/pipeline/llm-orchestrator.ts
// Fase 4 — Ciclo LLM + Tool Loop
//
// Responsabilidade única: chamar o LLM, detectar tool calls,
// executar as ferramentas e fazer a segunda chamada de síntese.
// Nenhuma outra fase sabe quantas chamadas ao LLM são feitas.
//
// Para adicionar uma nova ferramenta: edite tools-executor.ts.
// Para mudar o modelo padrão: edite prompt-assembler.ts.
// Este arquivo só muda se o PROTOCOLO de tool-calling mudar.

import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway';
import { executeTool } from '@/lib/chat/tools-executor';
import type { ChatRequestContext } from './request-context';
import type { ChatPrompt } from './prompt-assembler';

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface ToolCallResult {
  tc: any;
  result: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function executeToolCalls(
  toolCalls: any[],
  authUserId: string,
  numericUserId: string,
  contextSnapshot: Record<string, any>[]   // ← últimos N turnos
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
    // Mensagem do assistente com as tool_calls
    {
      role: 'assistant',
      content: firstContent || null,
      tool_calls: toolCalls.map((tc: any) => ({
        id:       tc.id,
        type:     'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    },
    // Resultados de cada ferramenta
    ...toolResults.map((tr: any) => ({
      role:         'tool',
      tool_call_id: tr.tc.id,
      content:      typeof tr.result === 'string'
        ? tr.result
        : JSON.stringify(tr.result),
    })),
  ];
}

// ─── Entrypoint público ───────────────────────────────────────────────────────

export async function runLLMOrchestrator(
  ctx: ChatRequestContext,
  prompt: ChatPrompt
): Promise<string> {
  const { user, requestSignature } = ctx;
  const { conversationMessages, tools, model } = prompt;

  // ── Primeiros 3 turnos do histórico como snapshot de contexto ─────────────
  const contextSnapshot = conversationMessages.slice(-3);

  // ── Primeira chamada ──────────────────────────────────────────────────────
  const firstResponse = await callOpenRouterWithPriority(
    1,
    'never',
    requestSignature,
    conversationMessages,
    tools,
    model,
    0.7
  );

  // Se não houve tool calls, retorna direto
  if (!firstResponse.toolCalls?.length) {
    return firstResponse.content || 'Entendido.';
  }

  // ── Tool loop ─────────────────────────────────────────────────────────────
  const toolResults = await executeToolCalls(
    firstResponse.toolCalls,
    user.auth_user_id,
    String(user.id),
    contextSnapshot                         // ← passado aqui
  );

  // ── Segunda chamada (síntese) ─────────────────────────────────────────────
  const toolMessages = buildToolCallMessages(
    firstResponse.content,
    firstResponse.toolCalls,
    toolResults
  );

  const secondResponse = await callOpenRouterWithPriority(
    1,
    'never',
    `${requestSignature}_synth`,
    [...conversationMessages, ...toolMessages],
    [],           // sem ferramentas na chamada de síntese
    model,
    0.7
  );

  return secondResponse.content || 'Entendido.';
}