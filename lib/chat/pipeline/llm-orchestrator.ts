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

// ─── Configurações ────────────────────────────────────────────────────────────

const FALLBACK_MODEL = 'google/gemini-2.5-flash';

// ─── Tipos Injetados (Blindagem TypeScript) ───────────────────────────────────
type ORPriority = Parameters<typeof callOpenRouterWithPriority>[0];
type ORCachePolicy = Parameters<typeof callOpenRouterWithPriority>[1];

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

// ─── Wrapper Anti-Falhas (Fallback Incondicional) ─────────────────────────────

async function callWithFallback(
  priority: ORPriority,
  cachePolicy: ORCachePolicy,
  requestSignature: string,
  messages: any[],
  tools: any[],
  primaryModel: string,
  temperature: number
) {
  try {
    // 1. Tenta executar com o modelo principal (Ex: Pro Experimental)
    return await callOpenRouterWithPriority(
      priority,
      cachePolicy,
      requestSignature,
      messages,
      tools,
      primaryModel,
      temperature
    );
  } catch (error: any) {
    // 2. Converte o erro oculto em string para podermos logar na Vercel e debugar futuramente
    const errorDetails = error?.message || error?.name || String(error);

    // 3. FALLBACK INCONDICIONAL: Se o modelo primário engasgar por QUALQUER motivo
    // e nós ainda não estivermos usando o modelo de resgate, fazemos a troca.
    if (primaryModel !== FALLBACK_MODEL) {
      console.warn(`[Orchestrator] Falha no modelo ${primaryModel} (${errorDetails}). Acionando Fallback para ${FALLBACK_MODEL}...`);
      
      try {
        // Executa a chamada de resgate imediatamente
        return await callOpenRouterWithPriority(
          priority,
          cachePolicy,
          `${requestSignature}_fallback_${Date.now()}`, // Sufixo de timestamp para não bugar o cache
          messages,
          tools,
          FALLBACK_MODEL,
          temperature
        );
      } catch (fallbackError) {
        console.error('[Orchestrator] Falha crítica no modelo de fallback:', fallbackError);
        throw fallbackError;
      }
    }

    // Se já era o fallback falhando, não tem o que fazer a não ser avisar o sistema
    console.error(`[Orchestrator] Falha Fatal no LLM de Resgate:`, error);
    throw error;
  }
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

  // ── Primeira chamada (agora blindada) ─────────────────────────────────────
  const firstResponse = await callWithFallback(
    1 as ORPriority,
    'never' as ORCachePolicy,
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
    contextSnapshot                         
  );

  // ── Segunda chamada de síntese (agora blindada) ───────────────────────────
  const toolMessages = buildToolCallMessages(
    firstResponse.content,
    firstResponse.toolCalls,
    toolResults
  );

  const secondResponse = await callWithFallback(
    1 as ORPriority,
    'never' as ORCachePolicy,
    `${requestSignature}_synth`,
    [...conversationMessages, ...toolMessages],
    [],           // sem ferramentas na chamada de síntese
    model,        
    0.7
  );

  return secondResponse.content || 'Entendido.';
}
