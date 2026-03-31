// src/app/api/transcribe/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { transcribeAudio } from '@/lib/services/transcription';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audioFile = formData.get('audio') as File | null;

    if (!audioFile) {
      return NextResponse.json({ error: 'Nenhum arquivo enviado' }, { status: 400 });
    }

    const arrayBuffer = await audioFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Detecta o tipo real pelo nome do arquivo enviado pelo cliente
    const fileName = (audioFile as any).name || 'audio.m4a';
    const mimeType = fileName.endsWith('.m4a') ? 'audio/mp4' : 'audio/ogg';

    const result = await transcribeAudio(buffer, { language: 'pt', mimeType });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: result.error?.includes('Autenticação') ? 401 : 500 }
      );
    }

    return NextResponse.json({ text: result.text, duration: result.duration, ok: true });

  } catch (error: any) {
    console.error('[Transcribe] Erro inesperado:', error);
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 });
  }
}