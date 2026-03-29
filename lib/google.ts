import { supabase } from './jarvis';

// --- 1. AUTENTICAÇÃO ---
export async function getGoogleAccessToken() {
  const { data } = await supabase.from('config').select('value').eq('key', 'google_refresh_token').single();

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

  if (!json.access_token) {
    console.error('[Google] Erro ao obter token:', JSON.stringify(json));
  }
  return json.access_token || null;
}

// --- 2. BUSCA NA WEB (SERPER.DEV) - Substitui a Custom Search bloqueada ---
export async function searchWeb(query: string) {
  try {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) return "Erro: Chave Serper ausente no .env";

    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q: query, gl: "br", hl: "pt-br" })
    });

    const data = await res.json();
    if (!data.organic?.length) return "Nenhum resultado preciso encontrado.";

    return data.organic.slice(0, 3).map((item: any) => 
      `Título: ${item.title}\nLink: ${item.link}\nResumo: ${item.snippet}`
    ).join('\n\n');
  } catch (err) {
    console.error('[Serper] Exceção:', err);
    return "Erro ao realizar busca na web.";
  }
}

// --- 3. CLIMA PRECISO (OPEN-METEO) - Para o Card de 5 dias no Vista Bela ---
export async function getWeatherForecast(lat: number = -23.2701, lng: number = -51.2044) {
  try {
    // Consulta previsão de 5 dias com temperaturas max/min e códigos de clima
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=America%2FSao_Paulo&forecast_days=5`;
    
    const res = await fetch(url);
    const data = await res.json();

    if (!data.daily) return "Não foi possível obter dados meteorológicos.";

    return data.daily.time.map((date: string, i: number) => {
      return `- ${date}: Máx ${data.daily.temperature_2m_max[i]}°C, Mín ${data.daily.temperature_2m_min[i]}°C (Código: ${data.daily.weathercode[i]})`;
    }).join('\n');
  } catch (err) {
    console.error('[Weather] Erro:', err);
    return "Erro ao processar previsão do tempo.";
  }
}

// --- 4. RECUPERAÇÃO DE CONTEXTO (Calendário) ---
export async function getGoogleContext() {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return "Erro ao recuperar agenda do Google.";

    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=5&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();

    if (data.error) return "Erro na API Calendar.";
    return data.items?.map((e: any) => `- ${e.summary} (${e.start.dateTime || e.start.date})`).join('\n') || "Agenda vazia.";
  } catch (err) {
    return "Erro ao recuperar agenda.";
  }
}

// --- 5. CRIAR EVENTO NO CALENDÁRIO ---
export async function createGoogleEvent(summary: string, startTime: string, reminderMinutes: number = 30) {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return "Erro: Token ausente.";
    
    const startIso = startTime.trim().replace(' ', 'T').substring(0, 19) + '-03:00';
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

    return res.ok ? `Agendado: ${summary}` : "Falha API Google.";
  } catch (err) {
    return "Erro interno ao agendar.";
  }
}

// --- 6. ATUALIZAR EVENTO NO CALENDÁRIO ---
export async function updateGoogleEvent(searchTerm: string, newSummary: string, newStartTime: string, reminderMinutes: number = 30) {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return "Erro de token.";
    
    const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(searchTerm)}&timeMin=${timeMin}&maxResults=1&singleEvents=true&orderBy=startTime`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const cal = await calRes.json();

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

    return res.ok ? `Corrigido: ${newSummary}` : "Falha API Google.";
  } catch (err) {
    return "Erro interno ao atualizar.";
  }
}

// --- 7. APAGAR EVENTO NO CALENDÁRIO ---
export async function deleteGoogleEvent(searchTerm: string) {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return "Erro de token.";
    
    const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(searchTerm)}&timeMin=${timeMin}&maxResults=1&singleEvents=true&orderBy=startTime`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const cal = await calRes.json();

    if (!cal.items?.length) return `Não achei "${searchTerm}".`;
    
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${cal.items[0].id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });

    return res.ok ? `Removido: "${searchTerm}".` : "Falha ao apagar.";
  } catch (err) {
    return "Erro interno ao deletar.";
  }
  }
