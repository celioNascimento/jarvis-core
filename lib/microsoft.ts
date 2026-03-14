import { supabase } from './jarvis';

// ============================================================
// lib/microsoft.ts — Outlook Calendar + Mail
// Usa Microsoft Graph API com OAuth2
// ============================================================

// 1. AUTENTICAÇÃO
export async function getMicrosoftAccessToken(): Promise<string | null> {
  const { data, error } = await supabase
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

  if (!json.access_token) {
    console.error('[Microsoft] Erro ao obter token:', JSON.stringify(json));
    return null;
  }

  // Atualiza refresh token se vier um novo
  if (json.refresh_token) {
    await supabase.from('config').upsert(
      { key: 'microsoft_refresh_token', value: json.refresh_token },
      { onConflict: 'key' }
    );
  }

  return json.access_token;
}

// 2. CONTEXTO DE AGENDA (próximos eventos)
export async function getMicrosoftCalendarContext(): Promise<string> {
  try {
    const token = await getMicrosoftAccessToken();
    if (!token) return "Erro ao recuperar agenda do Outlook.";

    const agora = new Date().toISOString();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${agora}&endDateTime=${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()}&$top=10&$orderby=start/dateTime&$select=subject,start,end,location`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const data = await res.json();
    if (!data.value?.length) return "Agenda Outlook vazia.";

    return data.value.map((e: any) =>
      `- ${e.subject} (${e.start.dateTime?.slice(0, 16).replace('T', ' ')})`
    ).join('\n');
  } catch (e) {
    console.error('[Microsoft] Erro getCalendarContext:', e);
    return "Erro ao recuperar agenda do Outlook.";
  }
}

// 3. CRIAR EVENTO NO CALENDÁRIO
export async function createOutlookEvent(
  summary: string,
  startTime: string,
  reminderMinutes: number = 30
): Promise<string> {
  try {
    const token = await getMicrosoftAccessToken();
    if (!token) return "Erro: Token ausente.";

    const startIso = startTime.trim().replace(' ', 'T').substring(0, 19);
    const startDate = new Date(`${startIso}-03:00`);
    const endDate   = new Date(startDate.getTime() + 3600000);

    const event = {
      subject: summary,
      start:   { dateTime: startDate.toISOString(), timeZone: 'America/Sao_Paulo' },
      end:     { dateTime: endDate.toISOString(),   timeZone: 'America/Sao_Paulo' },
      reminderMinutesBeforeStart: reminderMinutes,
      isReminderOn: true,
    };

    const res = await fetch('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

    if (res.ok) return `Agendado: ${summary}`;
    
    const text = await res.text();
    let errMsg = 'Erro API';
    try { errMsg = JSON.parse(text)?.error?.message || errMsg; } catch {}
    console.error('[Microsoft] createOutlookEvent falhou:', res.status);
    return `Falha: ${errMsg}`;
  } catch (e) {
    console.error('[Microsoft] Erro createOutlookEvent:', e);
    return "Erro interno ao agendar.";
  }
}

// 4. ATUALIZAR EVENTO NO CALENDÁRIO
export async function updateOutlookEvent(
  searchTerm: string,
  newSummary: string,
  newStartTime: string,
  reminderMinutes: number = 30
): Promise<string> {
  try {
    const token = await getMicrosoftAccessToken();
    if (!token) return "Erro de token.";

    // Busca evento pelo termo
    const searchRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/events?$filter=contains(subject,'${encodeURIComponent(searchTerm)}')&$top=1&$select=id,subject`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const searchData = await searchRes.json();
    if (!searchData.value?.length) return `Não achei "${searchTerm}".`;

    const eventId  = searchData.value[0].id;
    const startIso = newStartTime.trim().replace(' ', 'T').substring(0, 19);
    const startDate = new Date(`${startIso}-03:00`);

    const event = {
      subject: newSummary,
      start:   { dateTime: startDate.toISOString(), timeZone: 'America/Sao_Paulo' },
      end:     { dateTime: new Date(startDate.getTime() + 3600000).toISOString(), timeZone: 'America/Sao_Paulo' },
      reminderMinutesBeforeStart: reminderMinutes,
    };

    const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${eventId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

    return res.ok ? `Corrigido: ${newSummary}` : "Falha API Outlook.";
  } catch (e) {
    console.error('[Microsoft] Erro updateOutlookEvent:', e);
    return "Erro interno ao atualizar.";
  }
}

// 5. LER EMAILS RECENTES
export async function getRecentEmails(maxEmails: number = 5): Promise<string> {
  try {
    const token = await getMicrosoftAccessToken();
    if (!token) return "Erro ao acessar emails.";

    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages?$top=${maxEmails}&$orderby=receivedDateTime desc&$select=subject,from,receivedDateTime,bodyPreview,isRead`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const data = await res.json();
    if (!data.value?.length) return "Nenhum email recente.";

    return data.value.map((m: any) => {
      const lido = m.isRead ? '' : ' 🔵';
      const de   = m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'Desconhecido';
      const data_str = m.receivedDateTime?.slice(0, 10);
      return `- ${lido}[${data_str}] ${m.subject} (de: ${de})\n  ${m.bodyPreview?.slice(0, 100)}...`;
    }).join('\n\n');
  } catch (e) {
    console.error('[Microsoft] Erro getRecentEmails:', e);
    return "Erro ao recuperar emails.";
  }
}

// 6. ENVIAR EMAIL
export async function sendOutlookEmail(
  to: string,
  subject: string,
  body: string
): Promise<string> {
  try {
    const token = await getMicrosoftAccessToken();
    if (!token) return "Erro de token.";

    const message = {
      message: {
        subject,
        body:         { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    };

    const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    return res.ok ? `Email enviado para ${to}` : "Falha ao enviar email.";
  } catch (e) {
    console.error('[Microsoft] Erro sendOutlookEmail:', e);
    return "Erro interno ao enviar email.";
  }
}
