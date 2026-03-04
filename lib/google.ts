import { supabase } from './jarvis';

// 1. AUTENTICAÇÃO
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

// 2. RECUPERAÇÃO DE CONTEXTO (Usado no Briefing e LER_CONTEXTO)
export async function getGoogleContext() {
  try {
    const token = await getGoogleAccessToken();
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=5&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    return data.items?.map((e: any) => `- ${e.summary} (${e.start.dateTime || e.start.date})`).join('\n') || "Agenda vazia.";
  } catch {
    return "Erro ao recuperar agenda do Google.";
  }
}

// 3. CRIAR EVENTO NO CALENDÁRIO
export async function createGoogleEvent(summary: string, startTime: string, reminderMinutes: number = 30) {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return "Erro: Token ausente.";
    
    let startIso = startTime.trim().replace(' ', 'T').substring(0, 19) + '-03:00';
    const startDate = new Date(startIso);
    
    const event = {
      summary,
      start: { dateTime: startDate.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: new Date(startDate.getTime() + 3600000).toISOString(), timeZone: 'America/Sao_Paulo' }, // Evento padrão de 1 hora
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: reminderMinutes }] }
    };
    
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    return res.ok ? `Agendado: ${summary}` : "Falha API Google.";
  } catch { return "Erro interno ao agendar."; }
}

// 4. ATUALIZAR EVENTO NO CALENDÁRIO
export async function updateGoogleEvent(searchTerm: string, newSummary: string, newStartTime: string, reminderMinutes: number = 30) {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return "Erro de token.";
    
    // Busca o evento pelo termo para pegar o ID
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(searchTerm)}&timeMin=${new Date().toISOString()}&maxResults=1`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const cal = await calRes.json();
    if (!cal.items?.length) return `Não achei "${searchTerm}".`;
    
    const eventId = cal.items[0].id;
    const startIso = newStartTime.trim().replace(' ', 'T').substring(0, 19) + '-03:00';
    
    const event = {
      summary: newSummary,
      start: { dateTime: startIso, timeZone: 'America/Sao_Paulo' },
      end: { dateTime: new Date(new Date(startIso).getTime() + 3600000).toISOString(), timeZone: 'America/Sao_Paulo' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: reminderMinutes }] }
    };
    
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    return res.ok ? `Corrigido: ${newSummary}` : "Falha API Google.";
  } catch { return "Erro interno ao atualizar."; }
}

// 5. APAGAR EVENTO NO CALENDÁRIO (Caso precise)
export async function deleteGoogleEvent(searchTerm: string) {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return "Erro de token.";
    
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(searchTerm)}&timeMin=${new Date().toISOString()}&maxResults=1`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const cal = await calRes.json();
    if (!cal.items?.length) return `Não achei "${searchTerm}".`;
    
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${cal.items[0].id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    
    return res.ok ? `Removido: "${searchTerm}".` : "Falha ao apagar.";
  } catch { return "Erro interno ao deletar."; }
}
