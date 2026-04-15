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
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });

    const data = await response.json();

    if (data.error) {
      return NextResponse.json({ stage: "Erro no Google", error: data.error });
    }

    // O Supabase precisa estar aqui dentro para garantir o schema 'jarvis'
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { db: { schema: 'jarvis' } }
    );

    // PERSISTÊNCIA: Aqui salvamos o refresh_token para uso eterno do Jarvis
    const { error: supaError } = await supabase
      .from('config')
      .upsert({ 
        key: 'google_refresh_token', 
        value: data.refresh_token,
        updated_at: new Date().toISOString() 
      }, { onConflict: 'key' });

    if (supaError) return NextResponse.json({ error: supaError.message });

    return NextResponse.json({ 
      success: true, 
      message: "Conexão estabelecida! O Jarvis agora tem acesso total." 
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message });
  }
}
