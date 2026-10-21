// lib/chat/pipeline/response-finalizer.ts
// Fase 5 — Cache, Persistência, TTS e Resposta HTTP
//
// V2 — Passa o último turno do assistente para o brain.service,
//       ancorando o embedding no contexto correto (janela de contexto).

import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { Redis } from '@upstash/redis';
import OpenAI from 'openai/index.js';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import type { ChatPrompt } from './types';
import { hasReminderIntent } from '@/lib/chat/pipeline/extractors/reminders.extractor';
import { qstash } from '@/lib/qstash';

const TTS_BUDGET_MS = 8_000;
const POST_RESPONSE_BUDGET_MS = 2_500;

function settleWithin<T>(task: Promise<T>, label: string): Promise<T | undefined> {
  return Promise.race([
    task,
    new Promise<undefined>((resolve) => {
      setTimeout(() => {
        console.warn(`[ResponseFinalizer] ${label} excedeu ${POST_RESPONSE_BUDGET_MS}ms`);
        resolve(undefined);
      }, POST_RESPONSE_BUDGET_MS);
    }),
  ]);
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const getOpenAI = () => {
  const apiKey = process.env.OPENAI_API_KEY_1;
  return apiKey ? new OpenAI({ apiKey }) : null;
};

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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TTS_BUDGET_MS);
      const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: cleanText,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });

      if (!elRes.ok) {
        throw new Error(`ElevenLabs Http ${elRes.status}: ${await elRes.text()}`);
      }

      const arrayBuffer = await elRes.arrayBuffer();
      clearTimeout(timeout);
      return Buffer.from(arrayBuffer).toString('base64');
    } else {
      const openai = getOpenAI();
      if (!openai) return null;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TTS_BUDGET_MS);
      const mp3 = await openai.audio.speech.create({
        model: 'tts-1',
        voice: (voiceId || 'alloy') as 'alloy',
        input: cleanText,
      }, { signal: controller.signal });
      clearTimeout(timeout);
      return Buffer.from(await mp3.arrayBuffer()).toString('base64');
    }
  } catch (e) {
    console.error('[ResponseFinalizer] TTS Error:', e);
    return null;
  }
}

// ─── Extrai o último turno do assistente do histórico local ───────────────────

function getLastAssistantTurn(ctx: ChatRequestContext): string | null {
  // localHistory vem do frontend em ordem cronológica [mais antigo → mais recente]
  // Busca o último turno com role 'assistant'
  const turns = [...ctx.localHistory].reverse();
  const lastAssistant = turns.find(t => t.role === 'assistant');
  return lastAssistant?.content ?? null;
}

// ─── Entrypoint público ───────────────────────────────────────────────────────

export async function finalizeResponse(
  ctx: ChatRequestContext,
  intel: ChatIntelligence,
  prompt: ChatPrompt,
  reply: string
): Promise<NextResponse> {
  // A resposta já está pronta: cache é pós-resposta e nunca pode bloquear o usuário.
  waitUntil(
    settleWithin(
      redis.set(ctx.replyKey, reply, { ex: 60 }),
      'cache Redis',
    ).catch((error) => {
      console.error('[ResponseFinalizer] Falha ao salvar cache:', error);
    }),
  );

  // 2. Gera áudio se solicitado
  const audioBase64 = ctx.speak && ctx.voiceSettings
    ? await generateTTS(reply, ctx.voiceSettings.provider, ctx.voiceSettings.voiceId)
    : null;

  // 3. Captura o último turno do assistente ANTES do background
  //    (ctx ainda está íntegro aqui — não depende de async)
  const lastAssistantTurn = getLastAssistantTurn(ctx);

  // O processamento pesado não pode ficar anexado à invocation do chat.
  // Promise.race/after apenas deixam de esperar; não cancelam fetches, timers
  // ou conexões já abertas. O QStash executa a persistência em outra request.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
    ? process.env.NEXT_PUBLIC_APP_URL
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : null;

  if (baseUrl && process.env.QSTASH_TOKEN) {
    const publishBackgroundJob = qstash.publishJSON({
      url: `${baseUrl}/api/chat/background`,
      body: {
        userId: String(ctx.user.id),
        nickname: ctx.user.nickname,
        authUserId: ctx.user.auth_user_id,
        sessionId: ctx.sessionId,
        message: ctx.message,
        reply,
        lastAssistantTurn,
        contexts: intel.contexts,
        reminder: hasReminderIntent(ctx.message),
      },
      retries: 2,
    });

    // Evita que uma indisponibilidade do QStash mantenha a invocation viva.
    waitUntil(Promise.race([
      publishBackgroundJob,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('QStash enqueue timeout')), 3_000)),
    ]).catch((error) => {
      console.error('[BackgroundTasks] Falha ao enfileirar:', error);
    }));
  } else {
    console.warn('[BackgroundTasks] QStash ou URL pública ausente; persistência ignorada.');
  }

  // 5. ✅ Responde IMEDIATAMENTE ao usuário — sem delay
  return NextResponse.json({
    reply,
    audioBase64,
    ok: true,
    sessionId:     ctx.sessionId,
    assistantName: ctx.user.assistant_name || 'Lev',
    performance:   `${Date.now() - ctx.startTime}ms`,
  });
}
