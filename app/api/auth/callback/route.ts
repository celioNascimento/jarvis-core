import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');

  if (!code) return NextResponse.json({ error: "Código não recebido do Google" });

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: 'https://jarvis-core-three.vercel.app/api/auth/callback',
        grant_type: 'authorization_code',
      }),
    });

    const data = await response.json();

    // SE O GOOGLE DER ERRO, VAMOS VER O PORQUÊ NA TELA
    if (data.error) {
      return NextResponse.json({ 
        stage: "Erro na troca do Token no Google", 
        error: data.error, 
        description: data.error_description 
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { db: { schema: 'jarvis' } }
    );

    const { error: supaError } = await supabase
      .from('config')
      .upsert({ key: 'google_refresh_token', value: data.refresh_token });

    if (supaError) {
      return NextResponse.json({ stage: "Erro ao gravar no Supabase", error: supaError.message });
    }

    return NextResponse.json({ success: true, message: "Token gravado! Verifique o Supabase agora." });

  } catch (error: any) {
    return NextResponse.json({ stage: "Erro Crítico no Servidor", message: error.message });
  }
}