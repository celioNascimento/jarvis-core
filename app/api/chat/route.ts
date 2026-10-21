// app/api/chat/route.ts — Pipeline Director

import { NextRequest, NextResponse } from 'next/server';
// 1. Import necessário para o background task
import { buildRequestContext } from '@/lib/chat/pipeline/request-context';
import { runIntelligencePipeline } from '@/lib/chat/pipeline/intelligence';
import { buildChatPrompt } from '@/lib/chat/pipeline/prompt-assembler';
import { runLLMOrchestrator } from '@/lib/chat/pipeline/llm-orchestrator';
import { finalizeResponse } from '@/lib/chat/pipeline/response-finalizer';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const ctx = await buildRequestContext(req);

    if (ctx.isCachedReply && ctx.cachedReply) {
      return NextResponse.json({
        reply: ctx.cachedReply,
        ok: true,
        sessionId: ctx.sessionId,
        performance: '0ms (cache)',
      });
    }

    const intel = await runIntelligencePipeline(ctx);
    const prompt = await buildChatPrompt(ctx, intel);
    const reply = await runLLMOrchestrator(ctx, prompt);

    // A persistência pós-resposta é agendada pelo finalizador. Não agende a
    // mesma atualização aqui: duas tarefas concorrentes prolongam a invocation
    // e podem atingir o timeout mesmo depois de a resposta estar pronta.

    // Finaliza a resposta sem esperar o banco de dados terminar
    return finalizeResponse(ctx, intel, prompt, reply); 

  } catch (e: unknown) {
    if (e instanceof Error && 'statusCode' in e && e.statusCode === 401) {
      return NextResponse.json({ error: 'Auth failed' }, { status: 401 });
    }
    console.error('[FATAL] Pipeline error:', e);
    return NextResponse.json({ error: 'Erro no motor do Lev.' }, { status: 500 });
  }
}
