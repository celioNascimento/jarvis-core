/**
 * Inicia o fluxo OAuth Google.
 * Acesse no browser: /api/auth/google?secret=SUA_GOOGLE_AUTH_SECRET
 */
import { NextRequest, NextResponse } from 'next/server';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
].join(' ');

export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret');

  if (secret !== process.env.GOOGLE_AUTH_SECRET) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }

  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID!,
    redirect_uri:  process.env.GOOGLE_REDIRECT_URI!,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',  // garante emissão do refresh_token
    prompt:        'consent',  // força reemissão mesmo se já autorizado antes
  });

  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}