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
import { detectImplicitNegativeFeedback } from '@/lib/tools/executors/learning';
import OpenAI from 'openai';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import type { ChatPrompt } from './prompt-assembler';
import { extractReminder, hasReminderIntent } from '@/lib/chat/pipeline/extractors/reminders.extractor';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY_1 });

// ─── TTS Adaptativo (OpenAI + ElevenLabs) ─────────────────────────────────────

async function generateTTS(text: string, provider: string, voiceId: string): Promise<string | null> {
  try {
    const cleanText = text.replace(/[*#_~]/g, '').trim();
    if (!cleanText) return null;

    if (provider === 'elevenlabs') {
      if (!process.env.ELEVENLABS_API_KEY) {
        console.warn('[TTS] ELEVENLABS_API_KEY ausente. Abortando áudio.');
        return null;
      }
      const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: cleanText,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      });

      if (!elRes.ok) {
        throw new Error(`ElevenLabs Http ${elRes.status}: ${await elRes.text()}`);
      }

      const arrayBuffer = await elRes.arrayBuffer();
      return Buffer.from(arrayBuffer).toString('base64');
    } else {
      const mp3 = await openai.audio.speech.create({
        model: 'tts-1',
        voice: (voiceId as any) || 'alloy',
        input: cleanText,
      });
      return Buffer.from(await mp3.arrayBuffer()).toString('base64');
    }

  } catch (e) {
    console.error('[ResponseFinalizer] TTS Error:', e);
    return null;
  }
}

// ─── Persistência em background ───────────────────────────────────────────────

function persistInBackground(
  ctx: ChatRequestContext,
  intel: ChatIntelligence,
  prompt: ChatPrompt,
  reply: string
): void {
  void (async () => {
    detectImplicitNegativeFeedback(ctx.message, ctx.user.id).catch(() => { });

    try {
      await supabase.from('brain').insert({
        user_id: ctx.user.id,
        session_id: ctx.sessionId,
        content: ctx.message,
        category: ctx.message.length < 15 ? 'noise' : 'info',
        metadata: {
          role: 'user',
          ai_reply: reply,
          contexts: intel.contexts,
          model: prompt.model,
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

    // Extração passiva de lembretes — só dispara se houver sinal na mensagem
    if (hasReminderIntent(ctx.message)) {
      extractReminder(
        String(ctx.user.id),
        ctx.user.auth_user_id,
        ctx.message,
        new Date().toISOString()
      ).catch(e => console.error('[ResponseFinalizer] Reminder extractor error:', e.message));
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
  await redis.set(ctx.replyKey, reply, { ex: 60 }).catch(() => { });

  // 2. TTS
  const audioBase64 = ctx.speak && ctx.voiceSettings
    ? await generateTTS(reply, ctx.voiceSettings.provider, ctx.voiceSettings.voiceId)
    : null;

  // 3. Efeitos colaterais em background (não bloqueiam)
  persistInBackground(ctx, intel, prompt, reply);

  // 4. Resposta HTTP
  return NextResponse.json({
    reply,
    audioBase64,
    ok: true,
    sessionId: ctx.sessionId,
    assistantName: ctx.user.assistant_name || 'Lev',
    performance: `${Date.now() - ctx.startTime}ms`,
  });
}