import { NextResponse } from 'next/server';

/**
 * Endpoint para listagem de vozes da ElevenLabs.
 * Este arquivo deve ser criado em: app/api/voice/list/route.ts
 */

export async function GET() {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;

    // Validação de segurança no servidor
    if (!apiKey) {
      console.error('[Voice List] Erro: ELEVENLABS_API_KEY não encontrada no ambiente.');
      return NextResponse.json(
        { error: 'Chave de API não configurada no servidor.' },
        { status: 500 }
      );
    }

    // Busca a lista de vozes disponíveis na conta
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      method: 'GET',
      headers: {
        'xi-api-key': apiKey,
      },
      // Cache de 1 hora para evitar chamadas excessivas à API externa
      next: { revalidate: 3600 } 
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('[Voice List] Erro da ElevenLabs:', errorData);
      return NextResponse.json(
        { error: errorData.detail?.message || 'Falha ao buscar vozes na ElevenLabs' },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    /**
     * Filtramos os dados para enviar apenas o necessário ao App.
     * Isso reduz o consumo de banda e facilita a renderização no React Native.
     */
    const cleanVoices = data.voices.map((v: any) => ({
      id: v.voice_id,
      name: v.name,
      preview: v.preview_url, // URL do áudio de exemplo
      category: v.category,
      labels: v.labels,       // Útil para filtrar por "accent", "description", etc.
    }));

    return NextResponse.json(cleanVoices);
  } catch (error: any) {
    console.error('[Voice List Internal Error]:', error);
    return NextResponse.json(
      { error: 'Erro interno ao processar a listagem de vozes' },
      { status: 500 }
    );
  }
}