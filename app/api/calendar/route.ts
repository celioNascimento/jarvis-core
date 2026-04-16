// app/api/calendar/route.ts
import { NextResponse } from 'next/server';
import { google } from 'googleapis';

export async function GET(req: Request) {
  try {
    // 1. Pega os tokens do seu banco (adapte conforme seu lib/google.ts)
    const { supabase } = await import('@/lib/jarvis');
    const { data: config } = await supabase.from('config').select('value').eq('key', 'google_tokens').single();
    
    if (!config?.value) return NextResponse.json({ events: [] });
    
    const tokens = JSON.parse(config.value);
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials(tokens);

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // 2. Busca eventos dos próximos 7 dias
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: 15,
      singleEvents: true,
      orderBy: 'startTime',
    });

    // 3. Formata para ficar IGUAL ao formato do Supabase
    const googleEvents = (res.data.items || []).map(item => ({
      id: `google_${item.id}`,
      title: item.summary || 'Evento sem título',
      event_date: item.start?.dateTime || item.start?.date || '',
      category: 'google', // Ajuda a colocar uma cor ou ícone diferente no app
      relevance_score: 0.5,
      notes: 'Google Calendar'
    }));

    return NextResponse.json({ events: googleEvents });
  } catch (error) {
    console.error('[Calendar API]', error);
    return NextResponse.json({ events: [] }, { status: 500 });
  }
}
