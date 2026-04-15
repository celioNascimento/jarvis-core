import { NextRequest, NextResponse } from 'next/server';

const scopes = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'email',
  'profile',
].join(' ');

export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret');

  if (secret !== process.env.GOOGLE_AUTH_SECRET) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }

  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID!,
    redirect_uri:  process.env.GOOGLE_REDIRECT_URI!, // DEVE SER: https://seudominio.com/api/auth/google/callback
    response_type: 'code',
    scope:         scopes,
    access_type:   'offline',
    prompt:        'consent',
  });

  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
