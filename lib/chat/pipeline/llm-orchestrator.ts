// lib/chat/pipeline/llm-orchestrator.ts
// V13.0.0 — Orquestrador Focado no Modelo Fine-Tuned (Hugging Face)

import { callLevModel } from '@/lib/chat/lev-gateway';
import { executeTool } from '@/lib/chat/tools-executor';
import type { ChatRequestContext } from './request-context';
import type { ChatPrompt } from './types';

// ── Tipos Explícitos ─────────────────────────────────────────────────────────

export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON-stringified
  };
};

export type ChatMessage =
  | { role: 'system'; content: string | null }
  | { role: 'user'; content: string | null }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type LLMResponse = {
  content: string | null;
  toolCalls?: ToolCall[];
  modelUsed: string;
};

interface ToolCallResult {
  tc: ToolCall;
  result: string;
}

// ── Padrões Estritos de Intenção Ativa ────────────────────────────────────────

const IMPERATIVE_INTENT_PATTERNS = [
  /(?:me\s+)?lembr[ae]|crie\s+(?:um\s+)?lembrete|me\s+avisa|notifica|daqui\s+a\s+\d+/i,
  /cancela.*(lembrete|aviso|evento|compromisso)/i,
  /agend[ae]|marqu?e|insira.*agenda|consulta\s+amanhã|reunião\s+às/i,
  /(?:quais|listar)\s+(?:são\s+os\s+)?(?:lembretes|compromissos|tarefas)\s+(?:ativos|pendentes|de\s+hoje)/i,
  /apaga.*evento|deleta.*evento|remove.*evento/i,
];

function resolveToolChoice(message: string): 'auto' | 'required' {
  const isImperative = IMPERATIVE_INTENT_PATTERNS.some((pattern) => pattern.test(message));
  if (isImperative) {
    console.log(`[Orchestrator] 🎯 Intenção estrita detectada. Forçando tool_choice: "required"`);
    return 'required';
  }
  return 'auto';
}

// ── Helpers de Execução ───────────────────────────────────────────────────────

async function executeToolCalls(
  toolCalls: ToolCall[],
  authUserId: string,
  numericUserId: string,
  sessionId: string,
  contextSnapshot: ChatMessage[]
): Promise<ToolCallResult[]> {
  return Promise.all(
    toolCalls.map(async (tc) => {
      try {
        const rawResult = await Promise.race([
          executeTool(tc, authUserId, numericUserId, contextSnapshot, sessionId),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve('Desculpe, esta ação demorou muito.'), 5000)
          ),
        ]);
        const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
        return { tc, result };
      } catch (err) {
        return {
          tc,
          result: 'Não foi possível executar esta ação no momento.',
        };
      }
    })
  );
}

function buildToolCallMessages(
  firstContent: string | null,
  toolCalls: ToolCall[],
  toolResults: ToolCallResult[]
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: firstContent,
      tool_calls: toolCalls,
    },
  ];

  toolResults.forEach((tr) => {
    messages.push({
      role: 'tool',
      tool_call_id: tr.tc.id,
      content: tr.result,
    });
  });

  return messages;
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

export async function runLLMOrchestrator(
  ctx: ChatRequestContext,
  prompt: ChatPrompt
): Promise<string> {
  const { user, message } = ctx;
  const { conversationMessages, tools } = prompt;

  const toolChoice = resolveToolChoice(message);

  // Conversas casuais: 1 step. Tools obrigatórias: até 2 steps (executa e responde).
  const isToolRequired = toolChoice === 'required';
  const MAX_STEPS = isToolRequired ? 2 : 1;

  const currentMessages = [
    { role: 'system' as const, content: prompt.systemPrompt },
    ...conversationMessages,
  ] as ChatMessage[];

  let passoAtual = 0;
  let loopResponse: LLMResponse | null = null;
  let ferramentasExecutadas = false;

  // ── FASE 1: Loop de Acumulo ───────────────────────────────────────────────
  while (passoAtual < MAX_STEPS) {
    passoAtual++;

    // O modelo só é forçado a usar tool no primeiro passo. Se ele já usou, o segundo passo é para gerar o texto final.
    const currentToolChoice = passoAtual === 1 ? toolChoice : 'auto';
    let stepFailed = false;

    try {
      loopResponse = await callLevModel(
        currentMessages,
        tools,
        0.7, 
        currentToolChoice
      );
    } catch (error) {
      console.error(`[Orchestrator] Erro no passo ${passoAtual}:`, error);
      stepFailed = true;
    }

    if (stepFailed) break;

    if (Array.isArray(loopResponse?.toolCalls) && loopResponse!.toolCalls!.length > 0) {
      ferramentasExecutadas = true;
      console.log(`[Orchestrator] 🚀 Passo ${passoAtual}: ${loopResponse!.toolCalls!.length} ferramenta(s).`);

      const toolResults = await executeToolCalls(
        loopResponse!.toolCalls!,
        user.auth_user_id,
        String(user.id),
        ctx.sessionId,
        currentMessages.slice(-3)
      );

      const toolMessages = buildToolCallMessages(
        loopResponse!.content,
        loopResponse!.toolCalls!,
        toolResults
      );
      
      currentMessages.push(...toolMessages);
      continue;
    } else {
      break;
    }
  }

  // ── FASE 2: Retorno da resposta final ───────────────────────────────────
  if (!loopResponse) {
    console.error('[Orchestrator] Nenhuma resposta LLM. Retornando fallback.');
    return 'Não consegui processar sua mensagem agora. Tente novamente em instantes.';
  }

  // O Qwen Fine-Tuned já gera a resposta final humanizada junto com o tool_call ou após ele.
  return loopResponse.content || 'Entendido.';
}
