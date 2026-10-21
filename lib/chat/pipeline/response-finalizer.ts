// lib/chat/pipeline/response-finalizer.ts
// Fase 5 — Cache, Persistência, TTS e Resposta HTTP
//
// V2 — Passa o último turno do assistente para o brain.service,
//       ancorando o embedding no contexto correto (janela de contexto).

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { extractAndSummarize } from '@/lib/extractor';
import { detectImplicitNegativeFeedback } from '@/lib/tools/executors/learning';
import OpenAI from 'openai/index.js';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import type { ChatPrompt } from './types';
import { extractReminder, hasReminderIntent } from '@/lib/chat/pipeline/extractors/reminders.extractor';
import { processStyleSignals } from '@/lib/chat/pipeline/style-learner';
import { after } from 'next/server';
import { insertBrainEntry } from '@/lib/services/brain.service';

const BACKGROUND_BUDGET_MS = 12_000;
const TTS_BUDGET_MS = 8_000;

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
  // 1. Cache da resposta (rápido)
  await redis.set(ctx.replyKey, reply, { ex: 60 }).catch(() => { });

  // 2. Gera áudio se solicitado
  const audioBase64 = ctx.speak && ctx.voiceSettings
    ? await generateTTS(reply, ctx.voiceSettings.provider, ctx.voiceSettings.voiceId)
    : null;

  // 3. Captura o último turno do assistente ANTES do background
  //    (ctx ainda está íntegro aqui — não depende de async)
  const lastAssistantTurn = getLastAssistantTurn(ctx);

  // 4. Define tarefas em background — NÃO usa await bloqueante!
  const backgroundTasks = async () => {
    const tasks = [
      detectImplicitNegativeFeedback(ctx.message, ctx.user.id),
      insertBrainEntry({
        userId: Number(ctx.user.id),
        sessionId: ctx.sessionId,
        content: ctx.message,
        lastAssistantTurn,
        category: ctx.message.length < 15 ? 'noise' : 'info',
        tags: intel.contexts as string[],
        metadata: {
          role: 'user',
          model: 'google/gemini-2.5-flash',
          ai_reply: reply,
          contexts: intel.contexts,
        },
      }),
      extractAndSummarize(String(ctx.user.id), ctx.user.nickname, ctx.message, reply),
      processStyleSignals(String(ctx.user.id), ctx.message),
    ];

    if (hasReminderIntent(ctx.message)) {
      tasks.push(extractReminder(
        String(ctx.user.id),
        ctx.user.auth_user_id,
        ctx.message,
        new Date().toISOString()
      ));
    }

    const results = await Promise.allSettled(tasks);
    results.forEach((result) => {
      if (result.status === 'rejected') {
        console.error('[BackgroundTasks] Falha isolada:', result.reason);
      }
    });
  };

  // O callback continua depois da resposta, mas tem orçamento próprio. Sem
  // esse limite, uma integração lenta mantém a invocation aberta até o
  // maxDuration e a Vercel registra "Task timeout" mesmo após o reply sair.
  after(async () => {
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        console.warn('[BackgroundTasks] Orçamento encerrado; resposta já enviada.');
        resolve();
      }, BACKGROUND_BUDGET_MS);
    });

    await Promise.race([
      backgroundTasks().catch(err =>
        console.error('[BackgroundTasks] Erro fatal:', err)
      ),
      timeout,
    ]);
  });

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
