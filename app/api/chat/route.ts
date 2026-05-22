// app/api/chat/route.ts — Pipeline Director

import { NextRequest, NextResponse } from 'next/server';
// 1. Import necessário para o background task
import { waitUntil } from '@vercel/functions'; 
import { updateL3 } from '@/lib/chat/pipeline/extractors/l3.extractor'; // Import do seu extrator

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

    // 2. DISPARO EM BACKGROUND (O "pulo do gato" da latência)
    // Usamos o intel.masterContext que já está populado na Fase 2.
    // O catch evita que um erro na gravação derrube a resposta do usuário.
    waitUntil(
      updateL3(String(ctx.user.id), intel.masterContext).catch((err) => 
      console.error('[Pipeline] Falha no background task L3:', err)
  )
 );

    // 3. Finaliza a resposta sem esperar o banco de dados terminar
    return finalizeResponse(ctx, intel, prompt, reply, req); 

  } catch (e: any) {
    if (e.statusCode === 401) {
      return NextResponse.json({ error: 'Auth failed' }, { status: 401 });
    }
    console.error('[FATAL] Pipeline error:', e);
    return NextResponse.json({ error: 'Erro no motor do Lev.' }, { status: 500 });
  }
}
