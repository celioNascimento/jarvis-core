// lib/chat/pipeline/llm-orchestrator.ts
// V12.0 — Orquestrador com Fallback Automático (Modal -> OpenRouter)

import { callLevModel } from '@/lib/chat/lev-gateway';
import { executeTool } from '@/lib/chat/tools-executor';
import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway'; // RESGATADO
import type { ChatRequestContext } from './request-context';
import type { ChatPrompt } from './types';

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string; };
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

interface ToolCallResult { tc: ToolCall; result: string; }

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

function shouldPrefetchPersonalMemory(message: string): boolean {
  return /\b(esposa|mulher|cônjuge|filh(?:o|a|os|as)|família|mãe|pai|irm(?:ão|ã)|nome da minha)\b/i.test(message);
}

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
        return { tc, result: 'Não foi possível executar esta ação no momento.' };
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
    { role: 'assistant', content: firstContent || "", tool_calls: toolCalls }, // content vazio em vez de null
  ];
  toolResults.forEach((tr) => {
    messages.push({ role: 'tool', tool_call_id: tr.tc.id, content: tr.result });
  });
  return messages;
}

export async function runLLMOrchestrator(
  ctx: ChatRequestContext,
  prompt: ChatPrompt
): Promise<string> {
  const { user, message, requestSignature } = ctx;
  const { conversationMessages, tools } = prompt;

  const isPersonalFactQuestion = shouldPrefetchPersonalMemory(message);
  const toolChoice = resolveToolChoice(message);
  // Informações pessoais já foram carregadas no masterContext e incorporadas ao
  // system prompt. Não faça uma segunda consulta nem exponha ferramentas ao
  // modelo para perguntas factuais: isso evita um tool loop e mantém o dado já
  // recuperado disponível para a síntese final.
  const requestTools = isPersonalFactQuestion ? [] : tools;
  const MAX_STEPS = requestTools.length > 0 ? 2 : 1;

  // Sanitização do histórico para o vLLM não quebrar com 'content: null'
  const currentMessages = [
    { role: 'system' as const, content: prompt.systemPrompt || "Você é o Lev." },
    ...conversationMessages,
  ].map((m: any) => {
    if (m.content === null || m.content === undefined) m.content = "";
    return m;
  }) as ChatMessage[];

  let passoAtual = 0;
  let loopResponse: LLMResponse | null = null;
  let ferramentasExecutadas = false;

  while (passoAtual < MAX_STEPS) {
    passoAtual++;
    const currentToolChoice = passoAtual === 1 ? toolChoice : 'auto';
    const stepSignature = passoAtual === 1 ? requestSignature : `${requestSignature}_step_${passoAtual}`;
    
    let stepFailed = false;

    try {
      // 1. Tenta a Modal (Modelo Fine-Tuned)
      loopResponse = await callLevModel(currentMessages, requestTools, 0.85, currentToolChoice);
    } catch (error) {
      console.warn(`[Orchestrator] ⚠️ Modal indisponível. Acionando Fallback OpenRouter...`);
      try {
        // 2. Fallback: Se a Modal der Timeout (Cold Start), usa o Gemini
        loopResponse = (await callOpenRouterWithPriority(
          1, 'never', stepSignature,
          currentMessages, tools, 'google/gemini-2.5-flash', 
          0.7, 15000, 4000, currentToolChoice
        )) as LLMResponse;
      } catch (fallbackError) {
        console.error(`[Orchestrator] Erro crítico no fallback:`, fallbackError);
        stepFailed = true;
      }
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

      const toolMessages = buildToolCallMessages(loopResponse!.content, loopResponse!.toolCalls!, toolResults);
      currentMessages.push(...toolMessages);
      continue;
    } else {
      break;
    }
  }

  if (!loopResponse) {
    return 'Não consegui processar sua mensagem agora. Tente novamente em instantes.';
  }

  return loopResponse.content || 'Entendido.';
}
