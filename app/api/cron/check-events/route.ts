import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  const { searchParams } = new URL(req.url);
  const authParam = searchParams.get('auth');

  if (
    authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
    authParam !== process.env.CRON_SECRET
  ) {
    return new Response('Unauthorized', { status: 401 });
  }

  const agora = new Date();
  const fuso = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const horaAtual = fuso.getHours();
  const anoAtual = fuso.getFullYear();

  const { data: users } = await supabase
    .from('users')
    .select('id, nickname, telegram_chat_id, notification_hour, timezone')
    .eq('notification_hour', horaAtual)
    .not('telegram_chat_id', 'is', null);

  if (!users || users.length === 0) {
    return NextResponse.json({ debug: 'sem usuários', horaAtual, anoAtual });
  }

  const user = users[0];
  const userFuso = new Date(agora.toLocaleString('en-US', {
    timeZone: user.timezone || 'America/Sao_Paulo'
  }));

  const { data: events } = await supabase
    .from('events')
    .select('id, title, event_date, priority, last_notified_year')
    .eq('user_id', user.id)
    .or(`last_notified_year.is.null,last_notified_year.neq.${anoAtual}`);

  const diagnostico = (events || []).map(ev => {
    const dataEv = new Date(ev.event_date);
    const evMes = dataEv.getUTCMonth();
    const evDia = dataEv.getUTCDate();

    const isHoje = evDia === userFuso.getDate() && evMes === userFuso.getMonth();

    const seteDias = new Date(userFuso);
    seteDias.setDate(userFuso.getDate() + 7);
    const isPrevia = evDia === seteDias.getDate() && evMes === seteDias.getMonth();

    const tresDias = new Date(userFuso);
    tresDias.setDate(userFuso.getDate() + 3);
    const isTresDias = evDia === tresDias.getDate() && evMes === tresDias.getMonth()
      && ev.priority === 'alta';

    return {
      title: ev.title,
      event_date: ev.event_date,
      evDia, evMes,
      hojeDate: userFuso.getDate(), hojeMes: userFuso.getMonth(),
      seteDiasDate: seteDias.getDate(), seteDiasMes: seteDias.getMonth(),
      tresDiasDate: tresDias.getDate(), tresDiasMes: tresDias.getMonth(),
      isHoje, isPrevia, isTresDias,
      dispara: isHoje || isPrevia || isTresDias,
    };
  });

  return NextResponse.json({ horaAtual, anoAtual, userFuso: userFuso.toISOString(), eventos: diagnostico });
}