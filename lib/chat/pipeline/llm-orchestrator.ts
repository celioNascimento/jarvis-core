// lib/chat/pipeline/llm-orchestrator.ts
// V11.3.0 — Tool Choice "required" de Alta Resiliência para Modelos Gemini

import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway';
import { executeTool } from '@/lib/chat/tools-executor';
import type { ChatRequestContext } from './request-context';
import type { ChatPrompt } from './prompt-assembler';

interface ToolCallResult { tc: any; result: string; }

// ── Padrões Estritos de Intenção Ativa ────────────────────────────────────────
const IMPERATIVE_INTENT_PATTERNS = [
  // Exige ação: "me lembra", "crie um lembrete", "me avisa", "daqui a x minutos"
  /(?:me\s+)?lembr[ae]|crie\s+(?:um\s+)?lembrete|me\s+avisa|notifica|daqui\s+a\s+\d+/i,
  // Exige ação de cancelamento
  /cancela.*(lembrete|aviso|evento|compromisso)/i,
  // Exige ação de agenda: "agende", "marque", "insira na agenda"
  /agend[ae]|marqu?e|insira.*agenda|consulta\s+amanhã|reunião\s+às/i,
  // Consulta de pendências reais (não perguntas genéricas sobre o sistema)
  /(?:quais|listar)\s+(?:são\s+os\s+)?(?:lembretes|compromissos|tarefas)\s+(?:ativos|pendentes|de\s+hoje)/i,
  // Exige ação de remoção
  /apaga.*evento|deleta.*evento|remove.*evento/i
];

/**
 * Determina se a IA pode escolher conversar ('auto') ou se deve ser
 * terminantemente obrigada a disparar uma ferramenta ('required').
 */
function resolveToolChoice(message: string): 'auto' | 'required' {
  const isImperative = IMPERATIVE_INTENT_PATTERNS.some(pattern => pattern.test(message));
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
  contextSnapshot: Record<string, any>[],
): Promise<ToolCallResult[]> {
  return Promise.all(toolCalls.map(async (tc: any) => ({
    tc,
    result: await executeTool(tc, authUserId, numericUserId, contextSnapshot, sessionId),
  })));
}

function buildToolCallMessages(firstContent: string | null, toolCalls: any[], toolResults: ToolCallResult[]): any[] {
  return [
    {
      role: 'assistant',
      content: firstContent || null,
      tool_calls: toolCalls.map((tc: any) => ({
        id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    },
    ...toolResults.map((tr: any) => ({
      role: 'tool', tool_call_id: tr.tc.id, content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
    })),
  ];
}

function appendResilienceNotice(text: string, requestedModel: string, usedModel: string): string {
  if (requestedModel.includes('pro') && usedModel.includes('flash')) {
    return text + `\n\n---\n*💡 Nota: O motor principal (Pro) está instável. Resposta gerada via motor de reserva (Flash).*`;
  }
  return text;
}

// ── Entrypoint ────────────────────────────────────────────────────────────────
export async function runLLMOrchestrator(ctx: ChatRequestContext, prompt: ChatPrompt): Promise<string> {
  const { user, requestSignature, sessionId, message } = ctx;
  const { conversationMessages, tools, model: requestedModel } = prompt;

  // Resolve dinamicamente se bloqueia a conversação comum
  const toolChoice = resolveToolChoice(message);

  const firstResponse = await callOpenRouterWithPriority(
    1, 'never', requestSignature, conversationMessages, tools, requestedModel, 0.1,
    25000, undefined, toolChoice
  );

  // Se o modo era 'required' e por algum motivo bizarro não veio toolCalls, 
  // significa que a infraestrutura barrou ou o cinto de ferramentas veio vazio.
  if (!firstResponse.toolCalls?.length) {
    return appendResilienceNotice(
      firstResponse.content || 'Entendido.',
      requestedModel,
      firstResponse.modelUsed || requestedModel
    );
  }

  const toolResults = await executeToolCalls(
    firstResponse.toolCalls,
    user.auth_user_id,
    String(user.id),
    sessionId,
    conversationMessages.slice(-3),
  );

  const toolMessages = buildToolCallMessages(firstResponse.content, firstResponse.toolCalls, toolResults);

  // Segunda fase (síntese) roda com temperatura humana (0.7) para gerar a resposta amigável
  const secondResponse = await callOpenRouterWithPriority(
    1, 'never', `${requestSignature}_synth`,
    [...conversationMessages, ...toolMessages], [], requestedModel, 0.7
  );

  return appendResilienceNotice(
    secondResponse.content || 'Entendido.',
    requestedModel,
    secondResponse.modelUsed || requestedModel
  );
}