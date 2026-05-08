// app/api/chat/route.ts — Pipeline Director
// V13.0.0
//
// Este arquivo NÃO deve ser editado para:
//   - Adicionar ferramentas        → tools-executor.ts
//   - Mudar comportamento do chat  → prompt-assembler.ts ou personality.ts
//   - Mudar como o LLM é chamado   → llm-orchestrator.ts
//   - Mudar como dados são salvos  → response-finalizer.ts
//   - Corrigir bugs de localização → request-context.ts
//
// Este arquivo só muda se a ORDEM ou o NÚMERO de fases mudar.

import { NextRequest, NextResponse } from 'next/server';
import { buildRequestContext }  from '@/lib/chat/pipeline/request-context';
import { runIntelligencePipeline } from '@/lib/chat/pipeline/intelligence';
import { buildChatPrompt }      from '@/lib/chat/pipeline/prompt-assembler';
import { runLLMOrchestrator }   from '@/lib/chat/pipeline/llm-orchestrator';
import { finalizeResponse }     from '@/lib/chat/pipeline/response-finalizer';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    // Fase 1: parse, auth, geo, dedup
    const ctx = await buildRequestContext(req);

    // Resposta cacheada (requisição duplicada)
    if (ctx.isCachedReply && ctx.cachedReply) {
      return NextResponse.json({
        reply:       ctx.cachedReply,
        ok:          true,
        sessionId:   ctx.sessionId,
        performance: '0ms (cache)',
      });
    }

    // Fase 2: embedding, classify, memória, emoção
    const intel = await runIntelligencePipeline(ctx);

    // Fase 3: módulos, geo, system prompt, ferramentas
    const prompt = await buildChatPrompt(ctx, intel);

    // Fase 4: LLM + tool loop
    const reply = await runLLMOrchestrator(ctx, prompt);

    // Fase 5: cache, persist, TTS, resposta HTTP
    return finalizeResponse(ctx, intel, prompt, reply);

  } catch (e: any) {
    // Auth failure retorna 401
    if (e.statusCode === 401) {
      return NextResponse.json({ error: 'Auth failed' }, { status: 401 });
    }
    console.error('[FATAL] Pipeline error:', e);
    return NextResponse.json({ error: 'Erro no motor do Jarvis.' }, { status: 500 });
  }
}