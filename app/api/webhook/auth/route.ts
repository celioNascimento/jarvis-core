import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');

  if (!code) return NextResponse.json({ error: "Código não enviado" }, { status: 400 });

  try {
    // 1. Troca o código pelo Refresh Token
    const res = await fetch('https://oauth2.googleapis.com/token', {
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

    const data = await res.json();

    if (data.error) throw new Error(data.error_description || data.error);

    // 2. Salva na tabela config (schema jarvis)
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { db: { schema: 'jarvis' } }
    );

    await supabase.from('config').upsert({
      key: 'google_refresh_token',
      value: data.refresh_token
    });

    return NextResponse.json({ success: true, message: "Jarvis Conectado! Pode voltar ao Telegram." });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}