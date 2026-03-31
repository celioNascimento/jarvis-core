// app/api/transcribe/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { transcribeAudio } from '@/lib/services/transcription';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || '';

    let buffer: Buffer;
    let mimeType = 'audio/mp4';

    if (contentType.includes('application/json')) {
      // ✅ React Native: envia base64 via JSON
      const body = await req.json();

      if (!body.audio) {
        return NextResponse.json({ error: 'Campo audio ausente' }, { status: 400 });
      }

      buffer = Buffer.from(body.audio as string, 'base64');
      mimeType = (body.mimeType as string) || 'audio/mp4';

    } else if (contentType.includes('multipart/form-data')) {
      // Fallback: FormData (browser / outros clientes)
      const formData = await req.formData();
      const audioField = formData.get('audio');

      if (!audioField) {
        return NextResponse.json({ error: 'Nenhum arquivo enviado' }, { status: 400 });
      }

      // FormData.get() retorna File | string — narrowing explícito
      if (typeof audioField === 'string') {
        return NextResponse.json({ error: 'Formato de áudio não suportado' }, { status: 400 });
      }

      // audioField é File (extends Blob) aqui
      const arrayBuffer = await audioField.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      mimeType = audioField.name?.endsWith('.m4a') ? 'audio/mp4' : (audioField.type || 'audio/mp4');

    } else {
      return NextResponse.json({ error: 'Content-Type não suportado' }, { status: 415 });
    }

    if (!buffer || buffer.length === 0) {
      return NextResponse.json({ error: 'Arquivo de áudio vazio' }, { status: 400 });
    }

    console.log(`[Transcribe] buffer: ${buffer.length} bytes, mimeType: ${mimeType}`);

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