// app/api/chat/route.ts — Pipeline Director
// V13.2.1 — Estável, compatível com Edge, Turbopack e Vercel

import { NextRequest, NextResponse } from 'next/server';

// ── Importações Críticas (garantidas como edge-compatible) ─────────────────────
import { buildRequestContext } from '@/lib/chat/pipeline/request-context';
import { runIntelligencePipeline } from '@/lib/chat/pipeline/intelligence';
import { buildChatPrompt } from '@/lib/chat/pipeline/prompt-assembler';
import { runLLMOrchestrator } from '@/lib/chat/pipeline/llm-orchestrator';
import { finalizeResponse } from '@/lib/chat/pipeline/response-finalizer';

// ✅ Runtime oficial para Edge
export const runtime = 'edge';

// 🔥 Entrypoint principal
export async function POST(req: NextRequest): Promise<Response> {
  // 🚨 Log imediato: se não aparecer, o problema é de bundling
  console.log('[API] /api/chat iniciado — V13.2.1');

  try {
    // Fase 1: contexto (auth, cache, geo)
    const ctx = await buildRequestContext(req);
    
    if (ctx.isCachedReply && ctx.cachedReply) {
      console.log('[API] Resposta em cache usada:', ctx.sessionId);
      return NextResponse.json({
        reply: ctx.cachedReply,
        ok: true,
        sessionId: ctx.sessionId,
        performance: '0ms (cache)',
      });
    }

    // Fase 2: inteligência (emoção, memória, classificação)
    const intel = await runIntelligencePipeline(ctx);

    // Fase 3: montagem do prompt (system + tools + contexto)
    const prompt = await buildChatPrompt(ctx, intel);

    // Fase 4: orquestração LLM + ferramentas
    const reply = await runLLMOrchestrator(ctx, prompt);

    // Fase 5: resposta + background (cache, persistência, TTS)
    // Passa `req` para habilitar waitUntil
    return finalizeResponse(ctx, intel, prompt, reply, req);

  } catch (e: any) {
    // 🔐 Tratamento explícito de erro de autenticação
    if (e.statusCode === 401) {
      console.warn('[API] Auth falhou:', e.message);
      return NextResponse.json({ error: 'Auth failed' }, { status: 401 });
    }

    // 💥 Erro inesperado — log detalhado
    console.error('[FATAL] Pipeline crash:', {
      message: e.message,
      stack: e.stack?.split('\n')[0],
      time: new Date().toISOString(),
    });

    return NextResponse.json(
      { 
        error: 'Erro interno do assistente.', 
        ok: false 
      },
      { status: 500 }
    );
  }
}
