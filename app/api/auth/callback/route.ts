// app/api/auth/callback/route.ts
// Rota temporária para capturar o code do Google OAuth e salvar refresh token
// REMOVER após usar

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');

  if (!code) {
    return NextResponse.json({ error: 'code ausente' }, { status: 400 });
  }

  // Troca o code pelo refresh token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri:  'https://jarvis-core-three.vercel.app/api/auth/callback',
      grant_type:    'authorization_code',
    }),
  });

  const data = await res.json();

  if (!data.refresh_token) {
    return NextResponse.json({ error: 'refresh_token ausente', data }, { status: 400 });
  }

  // Salva no banco
  await supabase.from('config').upsert(
    { key: 'google_refresh_token', value: data.refresh_token },
    { onConflict: 'key' }
  );

  return NextResponse.json({ ok: true, message: 'Refresh token salvo com sucesso!' });
}