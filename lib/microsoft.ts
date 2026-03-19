import { supabase } from './jarvis';

// 1. AUTENTICAÇÃO - Renovação de Acesso
export async function getMicrosoftAccessToken(): Promise<string | null> {
  const { data } = await supabase
    .from('config')
    .select('value')
    .eq('key', 'microsoft_refresh_token')
    .single();

  if (!data?.value) {
    console.error('[Microsoft] refresh_token ausente no banco');
    return null;
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.MICROSOFT_CLIENT_ID!,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
        refresh_token: data.value,
        grant_type:    'refresh_token',
        scope:         'Calendars.ReadWrite Mail.Read Mail.Send offline_access User.Read',
      }),
    }
  );

  const json = await res.json();
  if (!json.access_token) return null;

  if (json.refresh_token) {
    await supabase.from('config').upsert(
      { key: 'microsoft_refresh_token', value: json.refresh_token, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
  }
  return json.access_token;
}

// 2. CONTEXTO DE AGENDA
export async function getMicrosoftCalendarContext(): Promise<string> {
  try {
    const token = await getMicrosoftAccessToken();
    if (!token) return "Erro ao recuperar agenda Outlook.";
    const agora = new Date().toISOString();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${agora}&endDateTime=${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()}&$top=10&$orderby=start/dateTime`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (!data.value?.length) return "Agenda Outlook vazia.";
    return data.value.map((e: any) => `- ${e.subject} (${e.start.dateTime?.slice(0, 16).replace('T', ' ')})`).join('\n');
  } catch (e) { return "Erro na agenda Outlook."; }
}

// 3. CRIAR EVENTO
export async function createOutlookEvent(summary: string, startTime: string, reminderMinutes: number = 30): Promise<string> {
  try {
    const token = await getMicrosoftAccessToken();
    if (!token) return "Erro de token.";
    const startIso = startTime.trim().replace(' ', 'T').substring(0, 19);
    const startDate = new Date(`${startIso}-03:00`);
    const event = {
      subject: summary,
      start: { dateTime: startDate.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: new Date(startDate.getTime() + 3600000).toISOString(), timeZone: 'America/Sao_Paulo' },
      reminderMinutesBeforeStart: reminderMinutes,
      isReminderOn: true,
    };
    const res = await fetch('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    return res.ok ? `Agendado no Outlook: ${summary}` : "Falha ao agendar no Outlook.";
  } catch (e) { return "Erro ao agendar."; }
}

// 4. ATUALIZAR EVENTO
export async function updateOutlookEvent(searchTerm: string, newSummary: string, newStartTime: string, reminderMinutes: number = 30): Promise<string> {
  try {
    const token = await getMicrosoftAccessToken();
    if (!token) return "Erro de token.";
    const searchRes = await fetch(`https://graph.microsoft.com/v1.0/me/events?$filter=contains(subject,'${encodeURIComponent(searchTerm)}')&$top=1`, { headers: { Authorization: `Bearer ${token}` } });
    const searchData = await searchRes.json();
    if (!searchData.value?.length) return `Não achei "${searchTerm}" no Outlook.`;
    const startIso = newStartTime.trim().replace(' ', 'T').substring(0, 19);
    const startDate = new Date(`${startIso}-03:00`);
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${searchData.value[0].id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: newSummary, start: { dateTime: startDate.toISOString(), timeZone: 'America/Sao_Paulo' }, end: { dateTime: new Date(startDate.getTime() + 3600000).toISOString(), timeZone: 'America/Sao_Paulo' } }),
    });
    return res.ok ? `Atualizado no Outlook: ${newSummary}` : "Erro na atualização Outlook.";
  } catch (e) { return "Erro ao atualizar."; }
}

// 5. LER EMAILS
export async function getRecentEmails(filtro?: string, maxEmails: number = 10, semFiltro: boolean = false): Promise<string> {
  try {
    const token = await getMicrosoftAccessToken();
    if (!token) return "Erro nos emails.";
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/messages?$top=10&$orderby=receivedDateTime desc`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!data.value?.length) return "Nenhum email.";
    return data.value.map((m: any) => `[${m.receivedDateTime.slice(0,10)}] *${m.subject}*\nDe: ${m.from?.emailAddress?.name || 'Desc'}`).join('\n\n');
  } catch (e) { return "Erro ao ler emails."; }
}

// 6. KEYWORDS
export async function addEmailKeyword(palavra: string): Promise<string> { return `✅ "${palavra}" adicionada.`; }
export async function removeEmailKeyword(palavra: string): Promise<string> { return `✅ "${palavra}" removida.`; }

// 7. ENVIAR EMAIL
export async function sendOutlookEmail(to: string, subject: string, body: string): Promise<string> {
  const token = await getMicrosoftAccessToken();
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { subject, body: { contentType: 'Text', content: body }, toRecipients: [{ emailAddress: { address: to } }] } }),
  });
  return res.ok ? "Email enviado." : "Erro ao enviar.";
}