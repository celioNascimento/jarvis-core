import { supabase } from './jarvis';

// 1. AUTENTICAÇÃO
export async function getGoogleAccessToken() {
  const { data } = await supabase.from('config').select('value').eq('key', 'google_refresh_token').single();

  console.log('[Google] refresh_token presente:', !!data?.value);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      client_id:     process.env.GOOGLE_CLIENT_ID, 
      client_secret: process.env.GOOGLE_CLIENT_SECRET, 
      refresh_token: data?.value, 
      grant_type:    'refresh_token' 
    }),
  });
  const json = await res.json();

  console.log('[Google] GOOGLE_CLIENT_ID presente:', !!process.env.GOOGLE_CLIENT_ID);
  console.log('[Google] GOOGLE_CLIENT_SECRET presente:', !!process.env.GOOGLE_CLIENT_SECRET);
  console.log('[Google] Resposta do token:', json.access_token ? 'OK' : `ERRO — ${JSON.stringify(json)}`);

  if (!json.access_token) {
    console.error('[Google] Erro ao obter token:', JSON.stringify(json));
  }
  return json.access_token || null;
}

// 2. RECUPERAÇÃO DE CONTEXTO (Usado no Briefing e LER_CONTEXTO)
export async function getGoogleContext() {
  try {
    const token = await getGoogleAccessToken();
    if (!token) {
      console.warn('[Google] getGoogleContext abortado — token ausente');
      return "Erro ao recuperar agenda do Google.";
    }

    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=5&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime`;
    console.log('[Google] Buscando eventos na URL:', url);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log('[Google] Status da resposta do Calendar:', res.status);

    const data = await res.json();

    if (data.error) {
      console.error('[Google] Erro na API Calendar:', JSON.stringify(data.error));
      return "Erro ao recuperar agenda do Google.";
    }

    const result = data.items?.map((e: any) => `- ${e.summary} (${e.start.dateTime || e.start.date})`).join('\n') || "Agenda vazia.";
    console.log('[Google] Eventos retornados:', data.items?.length ?? 0);
    return result;

  } catch (err) {
    console.error('[Google] Exceção em getGoogleContext:', err);
    return "Erro ao recuperar agenda do Google.";
  }
}

// 3. CRIAR EVENTO NO CALENDÁRIO
export async function createGoogleEvent(summary: string, startTime: string, reminderMinutes: number = 30) {
  try {
    const token = await getGoogleAccessToken();
    console.log('[Google] createGoogleEvent token:', token ? 'OK' : 'NULL');
    if (!token) return "Erro: Token ausente.";
    
    let startIso = startTime.trim().replace(' ', 'T').substring(0, 19) + '-03:00';
    const startDate = new Date(startIso);
    
    const event = {
      summary,
      start: { dateTime: startDate.toISOString(), timeZone: 'America/Sao_Paulo' },
      end:   { dateTime: new Date(startDate.getTime() + 3600000).toISOString(), timeZone: 'America/Sao_Paulo' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: reminderMinutes }] }
    };
    
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });

    console.log('[Google] createGoogleEvent status:', res.status);
    return res.ok ? `Agendado: ${summary}` : "Falha API Google.";

  } catch (err) {
    console.error('[Google] Exceção em createGoogleEvent:', err);
    return "Erro interno ao agendar.";
  }
}

// 4. ATUALIZAR EVENTO NO CALENDÁRIO
export async function updateGoogleEvent(searchTerm: string, newSummary: string, newStartTime: string, reminderMinutes: number = 30) {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return "Erro de token.";
    
    // timeMin: 30 dias atrás — permite encontrar eventos do dia que já passaram
    const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(searchTerm)}&timeMin=${timeMin}&maxResults=1&singleEvents=true&orderBy=startTime`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const cal = await calRes.json();

    console.log('[Google] updateGoogleEvent — eventos encontrados:', cal.items?.length ?? 0, 'para busca:', searchTerm);

    if (!cal.items?.length) return `Não achei "${searchTerm}".`;
    
    const eventId = cal.items[0].id;
    const startIso = newStartTime.trim().replace(' ', 'T').substring(0, 19) + '-03:00';
    
    const event = {
      summary: newSummary,
      start: { dateTime: startIso, timeZone: 'America/Sao_Paulo' },
      end:   { dateTime: new Date(new Date(startIso).getTime() + 3600000).toISOString(), timeZone: 'America/Sao_Paulo' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: reminderMinutes }] }
    };
    
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });

    console.log('[Google] updateGoogleEvent status:', res.status);
    return res.ok ? `Corrigido: ${newSummary}` : "Falha API Google.";

  } catch (err) {
    console.error('[Google] Exceção em updateGoogleEvent:', err);
    return "Erro interno ao atualizar.";
  }
}

// 5. APAGAR EVENTO NO CALENDÁRIO
export async function deleteGoogleEvent(searchTerm: string) {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return "Erro de token.";
    
    // timeMin: 30 dias atrás — permite encontrar eventos do dia que já passaram
    const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(searchTerm)}&timeMin=${timeMin}&maxResults=1&singleEvents=true&orderBy=startTime`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const cal = await calRes.json();

    console.log('[Google] deleteGoogleEvent — eventos encontrados:', cal.items?.length ?? 0, 'para busca:', searchTerm);

    if (!cal.items?.length) return `Não achei "${searchTerm}".`;
    
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${cal.items[0].id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log('[Google] deleteGoogleEvent status:', res.status);
    return res.ok ? `Removido: "${searchTerm}".` : "Falha ao apagar.";

  } catch (err) {
    console.error('[Google] Exceção em deleteGoogleEvent:', err);
    return "Erro interno ao deletar.";
  }
}