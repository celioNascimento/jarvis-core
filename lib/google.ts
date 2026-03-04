import { supabase } from './jarvis';

export async function getGoogleAccessToken() {
  const { data } = await supabase.from('config').select('value').eq('key', 'google_refresh_token').single();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: JSON.stringify({ 
      client_id: process.env.GOOGLE_CLIENT_ID, 
      client_secret: process.env.GOOGLE_CLIENT_SECRET, 
      refresh_token: data?.value, 
      grant_type: 'refresh_token' 
    }),
  });
  const json = await res.json();
  return json.access_token;
}

export async function getGoogleContext() {
  const token = await getGoogleAccessToken();
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=5&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  return data.items?.map((e: any) => `- ${e.summary} (${e.start.dateTime || e.start.date})`).join('\n') || "Agenda vazia.";
}
