import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// ============================================================
// CRON: NOTIFICAÇÕES PROATIVAS — Roda diariamente às 07:00
// Verifica events próximos e envia mensagem via Telegram
// app/api/cron/notifications/route.ts
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

function buildMessage(events: any[], authorName: string): string | null {
  if (events.length === 0) return null;

  const today = new Date();
  const lines: string[] = [];

  for (const ev of events) {
    const evDate = new Date(ev.event_date);
    // Calcula dias até o evento (considerando recorrência anual)
    const thisYear = new Date(today.getFullYear(), evDate.getMonth(), evDate.getDate());
    const diff = Math.round((thisYear.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (diff === 0) {
      lines.push(`🎉 *Hoje* — ${ev.title}`);
    } else if (diff === 1) {
      lines.push(`⏰ *Amanhã* — ${ev.title}`);
    } else if (diff <= 3) {
      lines.push(`📅 *Em ${diff} dias* — ${ev.title}`);
    } else if (diff <= 7) {
      lines.push(`📌 *Em ${diff} dias* — ${ev.title}`);
    }
  }

  if (lines.length === 0) return null;

  return `Bom dia, ${authorName}! 👋\n\n${lines.join('\n')}`;
}

export async function GET(req: Request) {
  // Autenticação
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
    // Busca todos os usuários ativos com chat_id
    const { data: users } = await supabase
      .from('users')
      .select('id, full_name, preferred_name, telegram_chat_id, timezone')
      .not('telegram_chat_id', 'is', null);

    if (!users || users.length === 0) {
      return NextResponse.json({ ok: true, notified: 0 });
    }

    const today = new Date();
    const todayMonth = today.getMonth() + 1;
    const todayDay = today.getDate();
    let totalNotified = 0;

    for (const user of users) {
      const authorName = user.preferred_name || user.full_name?.split(' ')[0] || 'você';

      // Busca eventos dos próximos 7 dias
      // Para recorrentes anuais: compara mês/dia ignorando ano
      // Para deadlines/one_time: compara data exata
      const { data: events } = await supabase
        .from('events')
        .select('title, event_date, decay_type, priority, emotional_weight, last_notified_year')
        .eq('user_id', user.id)
        .order('emotional_weight', { ascending: false });

      if (!events || events.length === 0) continue;

      // Filtra eventos relevantes para os próximos 7 dias
      const relevant = events.filter((ev: any) => {
        const evDate = new Date(ev.event_date);
        const evMonth = evDate.getMonth() + 1;
        const evDay = evDate.getDate();

        if (ev.decay_type === 'recurring_annual') {
          // Calcula próxima ocorrência
          const thisYear = new Date(today.getFullYear(), evMonth - 1, evDay);
          const diff = Math.round((thisYear.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

          // Já notificou esse ano?
          const alreadyNotified = ev.last_notified_year === today.getFullYear();

          return diff >= 0 && diff <= 7 && !alreadyNotified;

        } else {
          // deadline ou one_time: data exata
          const diff = Math.round((evDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
          return diff >= 0 && diff <= 7;
        }
      });

      if (relevant.length === 0) continue;

      // Monta mensagem
      const message = buildMessage(relevant, authorName);
      if (!message) continue;

      // Envia
      await sendTelegram(user.telegram_chat_id, message);
      console.log(`[Notificações] Enviado para ${authorName} — ${relevant.length} evento(s)`);

      // Atualiza last_notified_year para eventos recorrentes notificados hoje ou amanhã
      for (const ev of relevant) {
        if (ev.decay_type === 'recurring_annual') {
          const evDate = new Date(ev.event_date);
          const thisYear = new Date(today.getFullYear(), evDate.getMonth(), evDate.getDate());
          const diff = Math.round((thisYear.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

          // Marca como notificado só quando falta 3 dias ou menos
          if (diff <= 3) {
            await supabase
              .from('events')
              .update({ last_notified_year: today.getFullYear() })
              .eq('user_id', user.id)
              .eq('title', ev.title);
          }
        }
      }

      totalNotified++;
    }

    return NextResponse.json({ ok: true, notified: totalNotified });

  } catch (e: any) {
    console.error('[Cron/Notificações] Erro:', e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}