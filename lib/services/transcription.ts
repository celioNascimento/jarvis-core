// src/lib/services/transcription.ts
// ✅ Serviço centralizado para transcrição via Whisper (OpenAI Direct)
// ✅ Usa OPENAI_API_KEY_1 — isolada do OpenRouter para controle de custos
// ✅ FIX: Buffer.slice() garante ArrayBuffer puro para compatibilidade com Blob
// ✅ FIX: mimeType configurável — suporta .m4a (React Native) e .ogg (outros)

import { OpenAI } from 'openai';

export interface TranscriptionOptions {
  language?: string;
  model?: string;
  timeoutMs?: number;
  mimeType?: string;
}

export interface TranscriptionResult {
  success: boolean;
  text?: string;
  error?: string;
  duration?: number;
}

const DEFAULT_OPTIONS: Required<TranscriptionOptions> = {
  language: 'pt',
  model: 'whisper-1',
  timeoutMs: 30000,
  mimeType: 'audio/mp4', // .m4a é audio/mp4 — compatível com Whisper
};

export async function transcribeAudio(
  audioBuffer: Buffer,
  options: TranscriptionOptions = {}
): Promise<TranscriptionResult> {
  const start = Date.now();
  const config = { ...DEFAULT_OPTIONS, ...options };

  try {
    const apiKey = process.env.OPENAI_API_KEY_1;

    if (!apiKey) {
      console.error('[Transcription] OPENAI_API_KEY_1 não configurada');
      return { success: false, error: 'Configuração de API inválida' };
    }

    const openai = new OpenAI({ apiKey });

    // Garante ArrayBuffer puro (sem SharedArrayBuffer) para o Blob
    const arrayBuffer = audioBuffer.buffer.slice(
      audioBuffer.byteOffset,
      audioBuffer.byteOffset + audioBuffer.byteLength
    ) as ArrayBuffer;

    const blob = new Blob([arrayBuffer], { type: config.mimeType });

    console.log(`[Transcription] Enviando blob — size: ${blob.size} bytes, type: ${blob.type}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    const transcription = await openai.audio.transcriptions.create(
      { file: blob, model: config.model, language: config.language } as any,
      { signal: controller.signal } as any
    );

    clearTimeout(timeout);

    const duration = Date.now() - start;
    console.log(`[Transcription] Sucesso em ${duration}ms`);

    return {
      success: true,
      text: transcription.text?.trim() || '',
      duration,
    };

  } catch (error: any) {
    const duration = Date.now() - start;

    if (error.name === 'AbortError') {
      console.warn(`[Transcription] Timeout após ${config.timeoutMs}ms`);
      return { success: false, error: 'Timeout na transcrição', duration };
    }

    if (error?.status === 401) {
      console.error('[Transcription] Chave API inválida ou expirada');
      return { success: false, error: 'Autenticação falhou', duration };
    }

    if (error?.status === 413) {
      console.warn('[Transcription] Arquivo muito grande');
      return { success: false, error: 'Áudio excede limite permitido', duration };
    }

    console.error(`[Transcription] Erro inesperado:`, {
      message: error?.message,
      status: error?.status,
      code: error?.code,
    });

    return {
      success: false,
      error: error?.message || 'Falha na transcrição',
      duration,
    };
  }
}

export async function extractAudioBuffer(file: File | Blob): Promise<Buffer> {
  if (file instanceof Buffer) return file;
  const arrayBuffer = await file.arrayBuffer();
  return Buffer.from(arrayBuffer);
}