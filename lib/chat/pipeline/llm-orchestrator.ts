// lib/chat/pipeline/llm-orchestrator.ts
// V11.4.0 — Mecanismo de Execução Sequencial Multi-Steps (Cross-Module Orchestration)

import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway';
import { executeTool } from '@/lib/chat/tools-executor';
import type { ChatRequestContext } from './request-context';
import type { ChatPrompt } from './prompt-assembler';

interface ToolCallResult { tc: any; result: string; }

// ── Padrões Estritos de Intenção Ativa ────────────────────────────────────────
const IMPERATIVE_INTENT_PATTERNS = [
  /(?:me\s+)?lembr[ae]|crie\s+(?:um\s+)?lembrete|me\s+avisa|notifica|daqui\s+a\s+\d+/i,
  /cancela.*(lembrete|aviso|evento|compromisso)/i,
  /agend[ae]|marqu?e|insira.*agenda|consulta\s+amanhã|reunião\s+às/i,
  /(?:quais|listar)\s+(?:são\s+os\s+)?(?:lembretes|compromissos|tarefas)\s+(?:ativos|pendentes|de\s+hoje)/i,
  /apaga.*evento|deleta.*evento|remove.*evento/i
];

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

  const toolChoice = resolveToolChoice(message);

  let currentMessages = [...conversationMessages];
  let passoAtual = 0;
  const MAX_STEPS = 4; // Teto de segurança para evitar loops infinitos ou timeouts na Vercel
  let loopResponse = null;
  let ferramentasExecutadas = false;

  // ── FASE 1: Loop de Acúmulo e Encadeamento de Dados (Multi-Steps) ───────────
  while (passoAtual < MAX_STEPS) {
    passoAtual++;

    // O required só força o primeiro passo. Os encadeamentos seguintes rodam em 'auto'
    const currentToolChoice = passoAtual === 1 ? toolChoice : 'auto';
    // Carimba o ID do passo a partir da segunda execução para blindar e isolar o cache do Redis
    const stepSignature = passoAtual === 1 ? requestSignature : `${requestSignature}_step_${passoAtual}`;

    loopResponse = await callOpenRouterWithPriority(
      1, 'never', stepSignature, currentMessages, tools, requestedModel, 0.1,
      25000, undefined, currentToolChoice
    );

    if (loopResponse.toolCalls?.length > 0) {
      ferramentasExecutadas = true;
      console.log(`[Orchestrator] 🚀 Passo ${passoAtual}: Executando ${loopResponse.toolCalls.length} tool(s).`);

      const toolResults = await executeToolCalls(
        loopResponse.toolCalls,
        user.auth_user_id,
        String(user.id),
        sessionId,
        currentMessages.slice(-3),
      );

      // Formata e empurra o bloco estruturado de requisição/resposta para a memória local do ciclo
      const toolMessages = buildToolCallMessages(loopResponse.content, loopResponse.toolCalls, toolResults);
      currentMessages.push(...toolMessages);

      // Continua o loop para permitir o cruzamento de outros módulos
      continue;
    } else {
      // IA decidiu não invocar ferramentas. Dados consolidados com sucesso.
      break;
    }
  }

  // ── FASE 2: Síntese Cognitiva Final ─────────────────────────────────────────
  
  // Otimização de tokens: se nenhuma ferramenta rodou no processo, devolve a resposta 
  // do primeiro tiro imediatamente sem gastar uma nova chamada de síntese à toa.
  if (!ferramentasExecutadas && loopResponse) {
    return appendResilienceNotice(
      loopResponse.content || 'Entendido.',
      requestedModel,
      loopResponse.modelUsed || requestedModel
    );
  }

  // Se houve encadeamento, consolidamos todo o histórico de execuções em texto amigável (0.7)
  const secondResponse = await callOpenRouterWithPriority(
    1, 'never', `${requestSignature}_synth`,
    currentMessages, [], requestedModel, 0.7
  );

  return appendResilienceNotice(
    secondResponse.content || 'Entendido.',
    requestedModel,
    secondResponse.modelUsed || requestedModel
  );
}
