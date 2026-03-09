import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// ============================================================
// CRON: CHECK-EVENTS v2 — Roda de hora em hora
// Verifica eventos próximos e notifica via Telegram
// app/api/cron/check-events/route.ts
// ============================================================

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

async function sendTelegram(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

async function callAI(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY;
  const baseUrl = process.env.OPENROUTER_API_KEY
    ? 'https://openrouter.ai/api/v1'
    : 'https://api.openai.com/v1';

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.OPENROUTER_API_KEY ? 'google/gemini-flash-1.5' : 'gpt-4o-mini',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

export async function GET(req: Request) {
  // Autenticação — aceita header ou query param (Vercel cron usa header)
  const authHeader = req.headers.get('authorization');
  const { searchParams } = new URL(req.url);
  const authParam = searchParams.get('auth');

  if (
    authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
    authParam !== process.env.CRON_SECRET
  ) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const agora = new Date();
    const fuso = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const horaAtual = fuso.getHours();
    const anoAtual = fuso.getFullYear();

    // Busca usuários com telegram_chat_id registrado
    // notification_hour: null = notifica sempre | valor = notifica só naquela hora
    const { data: users } = await supabase
      .from('users')
      .select('id, nickname, telegram_chat_id, notification_hour, timezone')
      .not('telegram_chat_id', 'is', null);

    // Filtra por hora configurada (null = sempre notifica)
    const usersParaNotificar = (users || []).filter((u: any) =>
      u.notification_hour === null || u.notification_hour === horaAtual
    );

    if (usersParaNotificar.length === 0) {
      return NextResponse.json({ ok: true, message: `Nenhum usuário para as ${horaAtual}h.` });
    }

    let totalNotificacoes = 0;

    for (const user of usersParaNotificar) {
      const authorName = user.nickname || 'você';
      const userFuso = new Date(agora.toLocaleString('en-US', {
        timeZone: user.timezone || 'America/Sao_Paulo'
      }));

      // Duas queries separadas — .or() com NULL + int falha silenciosamente
      const [evNulos, evAntigos] = await Promise.all([
        supabase.from('events')
          .select('id, title, event_date, priority, decay_type, emotional_weight, last_notified_year, notes')
          .eq('user_id', user.id)
          .is('last_notified_year', null),
        supabase.from('events')
          .select('id, title, event_date, priority, decay_type, emotional_weight, last_notified_year, notes')
          .eq('user_id', user.id)
          .neq('last_notified_year', anoAtual),
      ]);

      const events = [...(evNulos.data || []), ...(evAntigos.data || [])];
      console.log(`[check-events] ${user.nickname} — ${events.length} eventos elegíveis (nulos: ${evNulos.data?.length || 0}, antigos: ${evAntigos.data?.length || 0})`);
      if (events.length === 0) continue;

      for (const event of events) {
        const dataEv = new Date(event.event_date);
        const evMes = dataEv.getUTCMonth();
        const evDia = dataEv.getUTCDate();
        const hoje = userFuso;

        // Verifica se é hoje
        const isHoje = evDia === hoje.getDate() && evMes === hoje.getMonth();

        // Verifica se é em exatamente 7 dias
        const seteDias = new Date(hoje);
        seteDias.setDate(hoje.getDate() + 7);
        const isPrevia = evDia === seteDias.getDate() && evMes === seteDias.getMonth();

        // Verifica se é em exatamente 3 dias (alta prioridade)
        const tresDias = new Date(hoje);
        tresDias.setDate(hoje.getDate() + 3);
        const isTresDias = evDia === tresDias.getDate() && evMes === tresDias.getMonth()
          && event.priority === 'alta';

        console.log(`[check-events] "${event.title}" — isHoje:${isHoje} isPrevia:${isPrevia} isTresDias:${isTresDias} evDia:${evDia} evMes:${evMes} hojeDate:${hoje.getDate()} hojeMes:${hoje.getMonth()} tresDias:${tresDias.getDate()}/${tresDias.getMonth()}`);
        if (!isHoje && !isPrevia && !isTresDias) continue;

        // Monta contexto para o tom
        const statusTxt = isHoje
          ? 'É HOJE'
          : isTresDias
          ? 'é daqui a 3 dias'
          : 'é daqui a 7 dias';

        const prompt = `Você é ${authorName === 'Celio' ? 'Jarvis' : 'Lev'}, assistente pessoal de ${authorName}.
Notifique sobre: "${event.title}" — ${statusTxt}.
Prioridade: ${event.priority}${event.notes ? `\nContexto: ${event.notes}` : ''}

REGRAS:
- Máximo 2 frases
- Tom: amigo direto — não robótico, não exagerado
- Se for aniversário de alguém: mencione a pessoa
- Se for prévia (3 ou 7 dias): sugira algo prático (presente, ligação, reserva)
- Se for hoje: seja direto e caloroso
- NUNCA use "Anotado", "Registrado" ou termos técnicos
- Sem hashtags, sem emojis excessivos — no máximo 1`;

        const mensagem = await callAI(prompt);
        if (!mensagem) continue;

        await sendTelegram(user.telegram_chat_id, mensagem);
        console.log(`[check-events] ${authorName} — "${event.title}" (${statusTxt})`);

        // Marca como notificado este ano
        await supabase
          .from('events')
          .update({ last_notified_year: anoAtual })
          .eq('id', event.id);

        totalNotificacoes++;
      }
    }

    return NextResponse.json({ 
      ok: true, 
      notificacoes: totalNotificacoes,
      debug: {
        horaAtual,
        anoAtual,
        totalUsuarios: users?.length || 0,
        usuariosParaNotificar: usersParaNotificar.length,
      }
    });

  } catch (error: any) {
    console.error('[check-events] Erro:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}