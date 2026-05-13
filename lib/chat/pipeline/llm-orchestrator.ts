// lib/chat/pipeline/llm-orchestrator.ts
import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway';
import { executeTool } from '@/lib/chat/tools-executor';
import type { ChatRequestContext } from './request-context';
import type { ChatPrompt } from './prompt-assembler';

interface ToolCallResult { tc: any; result: string; }

async function executeToolCalls(
  toolCalls: any[], 
  authUserId: string, 
  numericUserId: string, 
  contextSnapshot: Record<string, any>[]
): Promise<ToolCallResult[]> {
  return Promise.all(toolCalls.map(async (tc: any) => ({
    tc,
    result: await executeTool(tc, authUserId, numericUserId, contextSnapshot),
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

export async function runLLMOrchestrator(ctx: ChatRequestContext, prompt: ChatPrompt): Promise<string> {
  const { user, requestSignature } = ctx;
  const { conversationMessages, tools, model: requestedModel } = prompt;

  const firstResponse = await callOpenRouterWithPriority(
    1, 'never', requestSignature, conversationMessages, tools, requestedModel, 0.7
  );

  if (!firstResponse.toolCalls?.length) {
    return appendResilienceNotice(firstResponse.content || 'Entendido.', requestedModel, firstResponse.modelUsed || requestedModel);
  }

  const toolResults = await executeToolCalls(firstResponse.toolCalls, user.auth_user_id, String(user.id), conversationMessages.slice(-3));
  const toolMessages = buildToolCallMessages(firstResponse.content, firstResponse.toolCalls, toolResults);

  const secondResponse = await callOpenRouterWithPriority(
    1, 'never', `${requestSignature}_synth`, [...conversationMessages, ...toolMessages], [], requestedModel, 0.7
  );

  return appendResilienceNotice(secondResponse.content || 'Entendido.', requestedModel, secondResponse.modelUsed || requestedModel);
}
