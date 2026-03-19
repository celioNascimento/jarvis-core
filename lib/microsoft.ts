import { supabase } from './jarvis';

// 1. AUTENTICAÇÃO - Renovação de Acesso Silenciosa
export async function getMicrosoftAccessToken(): Promise<string | null> {
  const { data } = await supabase
    .from('config')
    .select('value')
    .eq('key', 'microsoft_refresh_token')
    .single();

  if (!data?.value) return null;

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
      { 
        key: 'microsoft_refresh_token', 
        value: json.refresh_token,
        updated_at: new Date().toISOString() 
      },
      { onConflict: 'key' }
    );
  }

  return json.access_token;
}

// 2. CONTEXTO DE AGENDA
export async function getMicrosoftCalendarContext(): Promise<string> {
  try {
    const token = await getMicrosoftAccessToken();
    if (!token) return "Erro ao recuperar agenda do Outlook.";

    const agora = new Date().toISOString();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${agora}&endDateTime=${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()}&$top=5&$orderby=start/dateTime`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const data = await res.json();
    if (!data.value?.length) return "Agenda Outlook vazia.";

    return data.value.map((e: any) =>
      `- ${e.subject} (${e.start.dateTime?.slice(0, 16).replace('T', ' ')})`
    ).join('\n');
  } catch (e) {
    return "Erro ao recuperar agenda do Outlook.";
  }
}

// 3. LER EMAILS (O que faltava para o Jarvis "enxergar")
export async function getRecentEmails(filtro?: string, maxEmails: number = 5, semFiltro: boolean = false): Promise<string> {
  try {
    const token = await getMicrosoftAccessToken();
    if (!token) return "Erro ao acessar e-mails.";

    // Busca os 20 mais recentes para poder filtrar internamente
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/messages?$top=20&$orderby=receivedDateTime desc&$select=subject,from,receivedDateTime,bodyPreview,isRead`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    let emails = data.value || [];

    // Lógica de Filtro por Keywords (Inteligência Jarvis)
    if (!semFiltro && !filtro) {
      const { data: kwData } = await supabase.from('config').select('value').eq('key', 'email_keywords').single();
      const keywords: string[] = kwData?.value ? JSON.parse(kwData.value) : ['urgente', 'fatura', 'entrega', 'white martins'];
      emails = emails.filter((m: any) => 
        keywords.some(k => m.subject?.toLowerCase().includes(k) || m.bodyPreview?.toLowerCase().includes(k))
      );
    } else if (filtro && filtro !== '*') {
      emails = emails.filter((m: any) => m.subject?.toLowerCase().includes(filtro.toLowerCase()));
    }

    const finalEmails = emails.slice(0, maxEmails);
    if (!finalEmails.length) return "Nenhum e-mail relevante encontrado.";

    return finalEmails.map((m: any) => {
      const status = m.isRead ? '' : '🔵 ';
      return `${status}[${m.receivedDateTime.slice(0,10)}] *${m.subject}*\nDe: ${m.from?.emailAddress?.name || 'Desconhecido'}\nPrévio: ${m.bodyPreview?.slice(0, 70)}...`;
    }).join('\n\n');
  } catch (e) {
    return "Erro ao ler e-mails.";
  }
}

// 4. CRIAR EVENTO
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

    return res.ok ? `Sucesso ao agendar: ${summary}` : "Falha na API da Microsoft.";
  } catch (e) {
    return "Erro interno ao criar evento.";
  }
}

// 5. ATUALIZAR EVENTO (Crucial para o Build)
export async function updateOutlookEvent(searchTerm: string, newSummary: string, newStartTime: string, reminderMinutes: number = 30): Promise<string> {
  try {
    const token = await getMicrosoftAccessToken();
    if (!token) return "Erro de token.";

    const searchRes = await fetch(`https://graph.microsoft.com/v1.0/me/events?$filter=contains(subject,'${encodeURIComponent(searchTerm)}')&$top=1`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const searchData = await searchRes.json();
    if (!searchData.value?.length) return `Evento "${searchTerm}" não encontrado no Outlook.`;

    const eventId = searchData.value[0].id;
    const startIso = newStartTime.trim().replace(' ', 'T').substring(0, 19);
    const startDate = new Date(`${startIso}-03:00`);

    const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${eventId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: newSummary,
        start: { dateTime: startDate.toISOString(), timeZone: 'America/Sao_Paulo' },
        end: { dateTime: new Date(startDate.getTime() + 3600000).toISOString(), timeZone: 'America/Sao_Paulo' }
      }),
    });

    return res.ok ? `Atualizado: ${newSummary}` : "Falha ao atualizar no Outlook.";
  } catch (e) {
    return "Erro interno ao atualizar.";
  }
}

// 6. AUXILIARES (Keywords e Envio)
export async function addEmailKeyword(palavra: string): Promise<string> {
  const { data } = await supabase.from('config').select('value').eq('key', 'email_keywords').single();
  let kws: string[] = data?.value ? JSON.parse(data.value) : [];
  if (!kws.includes(palavra.toLowerCase())) {
    kws.push(palavra.toLowerCase());
    await supabase.from('config').upsert({ key: 'email_keywords', value: JSON.stringify(kws) });
  }
  return `✅ "${palavra}" agora monitorada.`;
}

export async function removeEmailKeyword(palavra: string): Promise<string> {
  const { data } = await supabase.from('config').select('value').eq('key', 'email_keywords').single();
  if (!data?.value) return "Lista vazia.";
  let kws: string[] = JSON.parse(data.value);
  kws = kws.filter(k => k !== palavra.toLowerCase());
  await supabase.from('config').upsert({ key: 'email_keywords', value: JSON.stringify(kws) });
  return `❌ "${palavra}" removida do radar.`;
}

export async function sendOutlookEmail(to: string, subject: string, body: string): Promise<string> {
  const token = await getMicrosoftAccessToken();
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { subject, body: { contentType: 'Text', content: body }, toRecipients: [{ emailAddress: { address: to } }] } }),
  });
  return res.ok ? "Email enviado via Outlook." : "Falha ao enviar e-mail.";
}