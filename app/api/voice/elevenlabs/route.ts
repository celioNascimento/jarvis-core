import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { text, voiceId = 'pMsC7pUrxvWicU6AGp2T' } = await req.json(); // ID padrão (ex: Orion)

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY!,
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2', // Ou turbo_v2.5 para menor latência
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!response.ok) throw new Error('Erro na síntese da ElevenLabs');

    // Retornamos o áudio como um stream de dados (ArrayBuffer)
    const audioBuffer = await response.arrayBuffer();
    
    return new NextResponse(audioBuffer, {
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  } catch (error) {
    return NextResponse.json({ error: 'Falha na voz' }, { status: 500 });
  }
}