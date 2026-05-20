// lib/chat/pipeline/llm-orchestrator.ts
// V11.5.2 — Orquestrador Multi-Steps com Tipagem Segura e Suporte a Ferramentas

import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway';
import { executeTool } from '@/lib/chat/tools-executor';
import type { ChatRequestContext } from './request-context';
import type { ChatPrompt } from './prompt-assembler';

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
    console.log(`[Orchestrator] 🎯 Intenção estrita detectada. Forçando tool_choice: "required"`);    return 'required';
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
            setTimeout(() => resolve('Desculpe, esta ação demorou muito.'), 3000)
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
    messages.push({      role: 'tool',
      tool_call_id: tr.tc.id,
      content: tr.result,
    });
  });

  return messages;
}

function appendResilienceNotice(text: string, requestedModel: string, usedModel: string): string {
  if (requestedModel.includes('pro') && usedModel.includes('flash')) {
    return text + `\n\n---\n*💡 Nota: O motor principal (${requestedModel}) está instável. Resposta gerada via reserva (${usedModel}).*`;
  }
  return text;
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

export async function runLLMOrchestrator(
  ctx: ChatRequestContext,
  prompt: ChatPrompt
): Promise<string> {
  const { user, requestSignature, message } = ctx;
  const { conversationMessages, tools, model: requestedModel } = prompt;

  const toolChoice = resolveToolChoice(message);
  let currentMessages = [
  { role: 'system' as const, content: prompt.systemPrompt },
  ...conversationMessages,
  ] as ChatMessage[];
  let passoAtual = 0;
  const MAX_STEPS = 2;
  let loopResponse: LLMResponse | null = null;
  let ferramentasExecutadas = false;

  // ── FASE 1: Loop de Acúmulo com Limite Estrito ──────────────────────────────
  while (passoAtual < MAX_STEPS) {
    passoAtual++;

    const currentToolChoice = passoAtual === 1 ? toolChoice : 'auto';
    const stepSignature = passoAtual === 1 ? requestSignature : `${requestSignature}_step_${passoAtual}`;

    try {
      loopResponse = await callOpenRouterWithPriority(
        1,
        'never',
        stepSignature,
        currentMessages,
        tools,
        requestedModel,
        0.1,
        25000,
        8000,        currentToolChoice
      ) as LLMResponse;
    } catch (error) {
      console.error(`[Orchestrator] Erro na chamada LLM no passo ${passoAtual}:`, error);
      break;
    }

    if (Array.isArray(loopResponse.toolCalls) && loopResponse.toolCalls.length > 0) {
      ferramentasExecutadas = true;
      console.log(`[Orchestrator] 🚀 Passo ${passoAtual}: Executando ${loopResponse.toolCalls.length} ferramenta(s).`);

      const toolResults = await executeToolCalls(
        loopResponse.toolCalls,
        user.auth_user_id,
        String(user.id),
        ctx.sessionId,
        currentMessages.slice(-3)
      );

      const toolMessages = buildToolCallMessages(loopResponse.content, loopResponse.toolCalls, toolResults);
      currentMessages.push(...toolMessages);

      continue;
    } else {
      break;
    }
  }

  // ── FASE 2: Síntese Cognitiva Final (com fallback seguro) ──────────────────

  if (!ferramentasExecutadas && loopResponse) {
    return appendResilienceNotice(
      loopResponse.content || 'Entendido.',
      requestedModel,
      loopResponse.modelUsed || requestedModel
    );
  }

  try {
    const fastModel = requestedModel.replace(/pro(-\w+)?/, 'fast$1');
    const synthesisResponse = (await callOpenRouterWithPriority(
      1,
      'never',
      `${requestSignature}_synth`,
      currentMessages,
      [],
      fastModel,
      0.7,
      15000,
      6000    )) as LLMResponse;

    return appendResilienceNotice(
      synthesisResponse.content || 'Ação concluída.',
      requestedModel,
      synthesisResponse.modelUsed || requestedModel
    );
  } catch (error) {
    console.error('[Orchestrator] Falha na síntese final:', error);
    return (
      loopResponse?.content ||
      'Ação realizada, mas houve um problema ao formatar a resposta.'
    );
  }
}
