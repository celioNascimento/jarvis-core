// lib/google.ts

import { supabase } from './jarvis';

// --- 1. AUTENTICAÇÃO ---
export async function getGoogleAccessToken() {
  const { data } = await supabase
    .from('config')
    .select('value')
    .eq('key', 'google_refresh_token')
    .maybeSingle();

  if (!data?.value) {
    console.error('[Google] Erro: google_refresh_token não encontrado na tabela config.');
    return null;
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: data.value,
      grant_type:    'refresh_token',
    }),
  });

  const json = await res.json();
  if (json.error === 'invalid_grant') throw new Error('GOOGLE_AUTH_EXPIRED');
  if (json.error) {
    console.error('[Google] Erro na renovação:', json.error, json.error_description);
    return null;
  }

  return json.access_token || null;
}

// --- 2. BUSCA NA WEB (SERPER.DEV) ---

// Gera filtro de data para o Serper no formato cdr
// Restringe resultados a uma janela de datas exata — evita SEO antigo
function buildDateFilter(daysBack: number = 2): string {
  const now  = new Date();
  const from = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

  const fmt = (d: Date) =>
    `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

  return `cdr:1,cd_min:${fmt(from)},cd_max:${fmt(now)}`;
}

/**
 * Busca esportiva via Serper /news — filtra por data para evitar resultados antigos de SEO.
 * Retorna notícias recentes com título + snippet ordenados por data.
 */
async function searchSportsNews(query: string, daysBack: number = 2): Promise<string | null> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch('https://google.serper.dev/news', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q:   query,
        gl:  'br',
        hl:  'pt-br',
        num: 5,
        tbs: buildDateFilter(daysBack),
      }),
    });

    const data = await res.json();
    if (!data.news?.length) return null;

    return data.news
      .slice(0, 4)
      .map((item: any) => {
        const date = item.date ? ` [${item.date}]` : '';
        return `${item.title}${date}\n${item.snippet}`;
      })
      .join('\n\n');
  } catch (err) {
    console.error('[Serper/news] Erro:', err);
    return null;
  }
}

/**
 * Busca esportiva estruturada via Serper /search com type=sports.
 * Retorna jogos com times e placar quando disponível.
 */
async function searchSportsStructured(query: string): Promise<string | null> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'br', hl: 'pt-br', type: 'sports' }),
    });

    const data = await res.json();
    const jogos = data.sportsResults?.games;

    if (jogos?.length) {
      return jogos.map((g: any) => {
        const home = g.teams?.[0];
        const away = g.teams?.[1];
        if (!home || !away) return null;
        const placarHome = home.score ?? '-';
        const placarAway = away.score ?? '-';
        const info = g.status || g.time || '';
        return `⚽ ${home.name} ${placarHome} x ${placarAway} ${away.name}${info ? ` (${info})` : ''}`;
      }).filter(Boolean).join('\n');
    }

    if (data.answerBox?.answer)  return data.answerBox.answer;
    if (data.answerBox?.snippet) return data.answerBox.snippet;

    return null;
  } catch (err) {
    console.error('[Serper/sports] Erro:', err);
    return null;
  }
}

/**
 * Detecta se a query é sobre esportes.
 */
function isQueryEsportiva(query: string): boolean {
  return /jogo|placar|futebol|champions|brasileir|premier|la liga|serie a|tabela|classifica|rodada|partida|esporte|resultado|ontem|hoje|gol/i.test(query);
}

/**
 * Detecta se a query é sobre resultado passado (ontem, anteontem, semana passada).
 */
function isQueryPassado(query: string): boolean {
  return /ontem|anteontem|semana passada|resultado.*\d{2}\/\d{2}|jogo.*passado/i.test(query);
}

/**
 * Busca web genérica via Serper /search.
 */
async function searchGeneric(query: string): Promise<string> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return 'Erro: Chave Serper ausente no .env';

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'br', hl: 'pt-br' }),
    });

    const data = await res.json();

    if (data.answerBox?.answer)  return data.answerBox.answer;
    if (data.answerBox?.snippet) return data.answerBox.snippet;
    if (!data.organic?.length)   return 'Nenhum resultado encontrado.';

    return data.organic.slice(0, 4).map((item: any) =>
      `${item.title}\n${item.snippet}`
    ).join('\n\n');
  } catch (err) {
    console.error('[Serper] Exceção:', err);
    return 'Erro ao realizar busca na web.';
  }
}

/**
 * Entrypoint principal de busca web.
 *
 * Estratégia para queries esportivas:
 *   1. Se for resultado passado → /news com filtro de data (evita SEO antigo)
 *   2. Se for jogo atual/hoje  → /search type=sports (dados estruturados)
 *   3. Fallback                → /search genérico
 */
export async function searchWeb(query: string): Promise<string> {
  if (isQueryEsportiva(query)) {
    // Resultado passado: usa /news com filtro de data
    if (isQueryPassado(query)) {
      const newsResult = await searchSportsNews(query, 3);
      if (newsResult) return newsResult;
    }

    // Jogo atual/hoje: usa /search type=sports
    const structuredResult = await searchSportsStructured(query);
    if (structuredResult) return structuredResult;

    // Fallback: /news sem filtro de data
    const newsResult = await searchSportsNews(query, 7);
    if (newsResult) return newsResult;
  }

  return searchGeneric(query);
}

// --- 3. CLIMA PRECISO (OPEN-METEO) ---
export async function getWeatherForecast(lat: number = -23.2701, lng: number = -51.2044) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=America%2FSao_Paulo&forecast_days=5`;
    const res  = await fetch(url);
    const data = await res.json();

    if (!data.daily) return 'Não foi possível obter dados meteorológicos.';

    return data.daily.time.map((date: string, i: number) =>
      `- ${date}: Máx ${data.daily.temperature_2m_max[i]}°C, Mín ${data.daily.temperature_2m_min[i]}°C (Código: ${data.daily.weathercode[i]})`
    ).join('\n');
  } catch (err) {
    console.error('[Weather] Erro:', err);
    return 'Erro ao processar previsão do tempo.';
  }
}

// --- 4. RECUPERAÇÃO DE CONTEXTO (Calendário) ---
export async function getGoogleContext() {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return 'Erro ao recuperar agenda do Google.';

    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=5&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime`;
    const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();

    if (data.error) return 'Erro na API Calendar.';
    return data.items?.map((e: any) => `- ${e.summary} (${e.start.dateTime || e.start.date})`).join('\n') || 'Agenda vazia.';
  } catch {
    return 'Erro ao recuperar agenda.';
  }
}

// --- 5. CRIAR EVENTO NO CALENDÁRIO ---
export async function createGoogleEvent(
  summary: string,
  startTime: string,
  reminderMinutes: number = 30,
): Promise<string> {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return 'Erro: Token do Google ausente.';

    const startIso  = startTime.trim().replace(' ', 'T').substring(0, 19) + '-03:00';
    const startDate = new Date(startIso);

    const event = {
      summary,
      start: { dateTime: startDate.toISOString(), timeZone: 'America/Sao_Paulo' },
      end:   { dateTime: new Date(startDate.getTime() + 3_600_000).toISOString(), timeZone: 'America/Sao_Paulo' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: reminderMinutes }] },
    };

    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

    return res.ok ? `Agendado no Google: ${summary}` : 'Falha na API do Google.';
  } catch (err) {
    console.error('[Google] Erro ao criar evento:', err);
    return 'Erro interno ao agendar no Google.';
  }
}

// --- 6. ATUALIZAR EVENTO NO CALENDÁRIO ---
export async function updateGoogleEvent(
  searchTerm: string,
  newSummary: string,
  newStartTime: string,
  reminderMinutes: number = 30,
): Promise<string> {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return 'Erro de token.';

    const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const calRes  = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(searchTerm)}&timeMin=${timeMin}&maxResults=1&singleEvents=true&orderBy=startTime`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const cal = await calRes.json();
    if (!cal.items?.length) return `Não achei "${searchTerm}".`;

    const eventId  = cal.items[0].id;
    const startIso = newStartTime.trim().replace(' ', 'T').substring(0, 19) + '-03:00';

    const event = {
      summary: newSummary,
      start: { dateTime: startIso, timeZone: 'America/Sao_Paulo' },
      end:   { dateTime: new Date(new Date(startIso).getTime() + 3_600_000).toISOString(), timeZone: 'America/Sao_Paulo' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: reminderMinutes }] },
    };

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      },
    );

    return res.ok ? `Corrigido: ${newSummary}` : 'Falha API Google.';
  } catch (err) {
    console.error('[Google] Erro ao atualizar evento:', err);
    return 'Erro interno ao atualizar.';
  }
}

// --- 7. APAGAR EVENTO NO CALENDÁRIO ---
export async function deleteGoogleEvent(searchTerm: string): Promise<string> {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return 'Erro de token.';

    const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const calRes  = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(searchTerm)}&timeMin=${timeMin}&maxResults=1&singleEvents=true&orderBy=startTime`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const cal = await calRes.json();
    if (!cal.items?.length) return `Não achei "${searchTerm}".`;

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${cal.items[0].id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );

    return res.ok ? `Removido: "${searchTerm}".` : 'Falha ao apagar.';
  } catch (err) {
    console.error('[Google] Erro ao apagar evento:', err);
    return 'Erro interno ao deletar.';
  }
}

// --- 8. MOVER EMAIL PARA LIXEIRA (GMAIL) ---
export async function trashGoogleEmail(messageId: string): Promise<string> {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return 'Erro de token.';

    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/trash`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    );

    return res.ok
      ? 'Email enviado para a lixeira com sucesso.'
      : 'Falha ao apagar email. Verifique as permissões.';
  } catch (err) {
    console.error('[Google] Erro ao mover email:', err);
    return 'Erro interno ao apagar email.';
  }
}

// --- 9. SINCRONIZAÇÃO HÍBRIDA (GOOGLE -> LEV) ---
export async function syncGoogleCalendarToLev(userId: bigint): Promise<boolean> {
  try {
    const token = await getGoogleAccessToken();
    if (!token) {
      console.warn('[Sync] Falha: Token do Google não encontrado ou expirado.');
      return false;
    }

    const timeMin = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`;
    const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (!res.ok) throw new Error(`Google API falhou com status ${res.status}`);

    const data  = await res.json();
    const items = data.items || [];
    if (!items.length) return true;

    const payload = items.map((item: any) => {
      const isAllDay = !!item.start.date;
      return {
        user_id:     userId,
        title:       item.summary     || 'Evento Sem Título',
        description: item.description || null,
        location:    item.location    || null,
        start_at:    item.start.dateTime || `${item.start.date}T00:00:00Z`,
        end_at:      item.end.dateTime   || `${item.end.date}T00:00:00Z`,
        all_day:     isAllDay,
        source:      'google',
        external_id: item.id,
        category:    'personal',
        synced_at:   new Date().toISOString(),
      };
    });

    const { error } = await supabase
      .schema('jarvis')
      .from('events')
      .upsert(payload, { onConflict: 'user_id, source, external_id', ignoreDuplicates: false });

    if (error) {
      console.error('[Sync] Erro no Upsert do Supabase:', error.message);
      return false;
    }

    console.log(`[Sync] Sucesso: ${payload.length} eventos do Google injetados no Lev.`);
    return true;
  } catch (err: any) {
    console.error('[Sync] Erro Crítico:', err.message);
    return false;
  }
}
