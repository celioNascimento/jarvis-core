// app/api/auth/microsoft/callback/route.ts
// Captura o code do Microsoft OAuth e salva refresh token no banco
// Manter — será reutilizado para renovar autenticação

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

// DEBUG — remove após confirmar funcionamento
console.log('[Microsoft/callback] SUPABASE_URL presente:', !!process.env.SUPABASE_URL);
console.log('[Microsoft/callback] SERVICE_ROLE_KEY presente:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code  = searchParams.get('code');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.json({ error, description: searchParams.get('error_description') }, { status: 400 });
  }

  if (!code) {
    return NextResponse.json({ error: 'code ausente' }, { status: 400 });
  }

  // Troca o code pelo refresh token
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.MICROSOFT_CLIENT_ID!,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
        code,
        redirect_uri:  'https://jarvis-core-three.vercel.app/api/auth/microsoft/callback',
        grant_type:    'authorization_code',
        scope:         'Calendars.ReadWrite Mail.Read Mail.Send offline_access User.Read',
      }),
    }
  );

  const data = await res.json();

  if (!data.refresh_token) {
    console.error('[Microsoft/callback] Resposta completa:', JSON.stringify(data));
    return NextResponse.json({ error: 'refresh_token ausente', data }, { status: 400 });
  }

  // Salva no banco
  console.log('[Microsoft/callback] refresh_token recebido:', data.refresh_token?.slice(0, 20));
  const { error: upsertError } = await supabase.from('config').upsert(
    { key: 'microsoft_refresh_token', value: data.refresh_token },
    { onConflict: 'key' }
  );
  console.log('[Microsoft/callback] upsert error:', upsertError ? JSON.stringify(upsertError) : 'OK');

  return NextResponse.json({
    ok: true,
    message: 'Microsoft conectado com sucesso! Pode fechar esta janela.',
    scope: data.scope,
  });
}