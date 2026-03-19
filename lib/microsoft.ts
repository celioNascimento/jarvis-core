import { supabase } from './jarvis';

// 1. AUTENTICAÇÃO - Renovação de Acesso Silenciosa
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

  if (!json.access_token) {
    console.error('[Microsoft] Erro ao obter token:', JSON.stringify(json));
    return null;
  }

  // RIGOR: Atualiza o refresh_token se a Microsoft enviar um novo (Rollover)
  // Incluímos updated_at para garantir que o banco registre a atividade de hoje
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

// 3. ENVIAR EMAIL
export async function sendOutlookEmail(to: string, subject: string, body: string): Promise<string> {
  try {
    const token = await getMicrosoftAccessToken();
    if (!token) return "Erro de token.";

    const message = {
      message: {
        subject,
        body: { contentType: 'Text', content: body },
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