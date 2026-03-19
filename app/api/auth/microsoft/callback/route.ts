import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

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
    return NextResponse.json({ error: 'refresh_token ausente', data }, { status: 400 });
  }

  // RIGOR TÉCNICO: Upsert garantido com carimbo de tempo
  const { error: upsertError } = await supabase.from('config').upsert(
    { 
      key: 'microsoft_refresh_token', 
      value: data.refresh_token,
      updated_at: new Date().toISOString() 
    },
    { onConflict: 'key' }
  );

  if (upsertError) {
    return NextResponse.json({ error: 'Erro no Supabase', detail: upsertError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    message: 'Microsoft conectado com sucesso! O Jarvis agora tem acesso ao Outlook.',
  });
}