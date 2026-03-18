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

    if (data.error) {
      return NextResponse.json({ 
        stage: "Erro na troca do Token no Google", 
        error: data.error, 
        description: data.error_description 
      });
    }

    // RIGOR: O Google só envia o refresh_token se o login tiver 'prompt=consent'
    // Se não vier, interrompemos para não sobrescrever o banco com NULL
    if (!data.refresh_token) {
      return NextResponse.json({ 
        success: false, 
        message: "O Google não enviou um novo Refresh Token. Tente novamente clicando no botão de consentimento." 
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { db: { schema: 'jarvis' } }
    );

    // UPSERT: Atualiza se a chave existir, insere se não existir.
    // Forçamos o updated_at para ignorar o valor estático do banco.
    const { error: supaError } = await supabase
      .from('config')
      .upsert({ 
        key: 'google_refresh_token', 
        value: data.refresh_token,
        updated_at: new Date().toISOString() 
      }, { onConflict: 'key' });

    if (supaError) {
      return NextResponse.json({ stage: "Erro ao gravar no Supabase", error: supaError.message });
    }

    return NextResponse.json({ 
      success: true, 
      message: "Conexão estabelecida! O Jarvis agora tem acesso à sua agenda (Data: " + new Date().toLocaleString('pt-BR') + ")" 
    });

  } catch (error: any) {
    return NextResponse.json({ stage: "Erro Crítico no Servidor", message: error.message });
  }
}