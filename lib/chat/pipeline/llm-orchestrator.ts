// lib/chat/pipeline/llm-orchestrator.ts
// V11.5.1 — Orquestrador Multi-Steps com Segurança de Tempo e Uso Eficiente de Tokens

import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway';
import { executeTool } from '@/lib/chat/tools-executor';
import type { ChatRequestContext } from './request-context';
import type { ChatPrompt } from './prompt-assembler';

interface ToolCallResult {
  tc: any;
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
  toolCalls: any[],
  authUserId: string,
  numericUserId: string,
  sessionId: string,
  contextSnapshot: any[]
): Promise<ToolCallResult[]> {
  return Promise.all(
    toolCalls.map(async (tc) => {
      const result = await Promise.race([
        executeTool(tc, authUserId, numericUserId, contextSnapshot, sessionId),
        new Promise<string>((resolve) => setTimeout(() => resolve('Desculpe, esta ação demorou muito.'), 3000)),
      ]);
      return { tc, result };
    })
  );
}
function buildToolCallMessages(
  firstContent: string | null,
  toolCalls: any[],
  toolResults: ToolCallResult[]
): any[] {
  const messages = [
    {
      role: 'assistant',
      content: firstContent || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    },
  ];

  toolResults.forEach((tr) => {
    messages.push({
      role: 'tool',
      tool_call_id: tr.tc.id,
      content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
    });
  });

  return messages;
}

function appendResilienceNotice(text: string, requestedModel: string, usedModel: string): string {
  if (requestedModel.includes('pro') && usedModel.includes('flash')) {
    return text + `\n\n---\n*💡 Nota: O motor principal (Pro) está instável. Resposta gerada via reserva (Flash).*`;
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
  let currentMessages = [...conversationMessages];
  let passoAtual = 0;
  const MAX_STEPS = 2;  let loopResponse: any = null;
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
        8000,
        currentToolChoice
      );
    } catch (error) {
      console.error(`[Orchestrator] Erro na chamada LLM no passo ${passoAtual}:`, error);
      break; // Sai do loop se houver falha
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

      continue; // Continua o loop para possível nova invocação
    } else {
      break; // Nenhuma tool call → saída natural
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
    const synthesisResponse = await callOpenRouterWithPriority(
      1,
      'never',
      `${requestSignature}_synth`,
      currentMessages,
      [],
      requestedModel.replace('pro', 'fast').replace('large', 'base'),
      0.7,
      15000,
      6000
    );

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
