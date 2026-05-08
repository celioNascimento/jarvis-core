// lib/chat/pipeline/response-finalizer.ts
// Fase 5 — Cache, Persistência, TTS e Resposta HTTP
//
// Responsabilidade única: receber a resposta do LLM e entregar
// o NextResponse ao cliente, disparando todos os efeitos colaterais
// (cache, banco, extração) sem bloquear o retorno.
//
// Para mudar como a resposta é salva: edite apenas este arquivo.
// Para mudar o que é extraído das conversas: edite unified-extractor.ts.
// Este arquivo só muda se o FORMATO DA RESPOSTA HTTP mudar.

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { supabase } from '@/lib/jarvis';
import { extractAndSummarize } from '@/lib/extractor';
import OpenAI from 'openai';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import type { ChatPrompt } from './prompt-assembler';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY_1 });

// ─── TTS ──────────────────────────────────────────────────────────────────────

async function generateTTS(text: string, voice: string): Promise<string | null> {
  try {
    const cleanText = text.replace(/[*#_~]/g, '').trim();
    if (!cleanText) return null;
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: voice as any,
      input: cleanText,
    });
    return Buffer.from(await mp3.arrayBuffer()).toString('base64');
  } catch (e) {
    console.error('[ResponseFinalizer] TTS Error:', e);
    return null;
  }
}

// ─── Persistência em background ───────────────────────────────────────────────
// Não bloqueia o retorno — dispara e esquece.

function persistInBackground(
  ctx: ChatRequestContext,
  intel: ChatIntelligence,
  prompt: ChatPrompt,
  reply: string
): void {
  // Usa void para não propagar o Promise — é intencional em Vercel edge
  void (async () => {
    try {
      await supabase.from('brain').insert({
        user_id:    ctx.user.id,
        session_id: ctx.sessionId,
        content:    ctx.message,
        category:   ctx.message.length < 15 ? 'noise' : 'info',
        metadata: {
          role:     'user',
          ai_reply: reply,
          contexts: intel.contexts,
          model:    prompt.model,
        },
      });
    } catch (e: any) {
      console.error('[ResponseFinalizer] Brain save error:', e.message);
    }

    try {
      await extractAndSummarize(
        String(ctx.user.id),
        ctx.user.nickname,
        ctx.message,
        reply
      );
    } catch (e: any) {
      console.error('[ResponseFinalizer] Extractor error:', e.message);
    }
  })();
}

// ─── Entrypoint público ───────────────────────────────────────────────────────

export async function finalizeResponse(
  ctx: ChatRequestContext,
  intel: ChatIntelligence,
  prompt: ChatPrompt,
  reply: string
): Promise<NextResponse> {
  // 1. Cache da resposta (para dedup de requisições duplicadas)
  await redis.set(ctx.replyKey, reply, { ex: 60 }).catch(() => {});

  // 2. TTS (só se solicitado)
  const audioBase64 = ctx.speak
    ? await generateTTS(reply, ctx.user.preferred_voice)
    : null;

  // 3. Efeitos colaterais em background (não bloqueiam)
  persistInBackground(ctx, intel, prompt, reply);

  // 4. Resposta HTTP
  return NextResponse.json({
    reply,
    audioBase64,
    ok:          true,
    sessionId:   ctx.sessionId,
    performance: `${Date.now() - ctx.startTime}ms`,
  });
}