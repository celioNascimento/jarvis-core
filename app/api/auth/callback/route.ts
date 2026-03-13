// Rota temporária de debug — app/api/debug-google/route.ts
// REMOVER após usar

import { NextResponse } from 'next/server';
import { getGoogleAccessToken } from '@/lib/google';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

export async function GET() {
  // Verifica vars de ambiente
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  // Busca refresh token no banco
  const { data, error } = await supabase
    .from('config')
    .select('value')
    .eq('key', 'google_refresh_token')
    .single();

  // Tenta obter access token e captura erro completo
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: data?.value,
      grant_type:    'refresh_token',
    }),
  });

  const json = await res.json();

  return NextResponse.json({
    client_id_present:     !!clientId,
    client_id_prefix:      clientId?.slice(0, 20),
    client_secret_present: !!clientSecret,
    refresh_token_present: !!data?.value,
    refresh_token_prefix:  data?.value?.slice(0, 20),
    oauth_response:        json,
  });
}