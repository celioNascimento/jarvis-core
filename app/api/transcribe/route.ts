import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audioFile = formData.get('audio') as File;
    if (!audioFile) {
      return NextResponse.json({ error: 'Nenhum arquivo enviado' }, { status: 400 });
    }

    const buffer = Buffer.from(await audioFile.arrayBuffer());
    const blob = new Blob([buffer], { type: audioFile.type });

    const transcription = await openai.audio.transcriptions.create({
      file: blob,
      model: 'whisper-1',
      language: 'pt',
    });

    return NextResponse.json({ text: transcription.text });
  } catch (error: any) {
    console.error('Erro na transcrição:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}