// app/api/reminders/test-fire/route.ts
// REMOVER EM PRODUÇÃO — apenas para debug
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_TEST_FIRE) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { userId, message } = body;

    const { data: userRecord } = await supabase
      .schema('jarvis')
      .from('users')
      .select('push_token, telegram_chat_id, nickname')
      .eq('id', Number(userId))
      .maybeSingle();

    if (!userRecord) {
      return NextResponse.json({ ok: false, error: 'user_not_found', userId });
    }

    const result: any = {
      ok: true,
      user: userRecord.nickname,
      expo_push_token: userRecord.push_token ? '✅ presente' : '❌ ausente',
      telegram_chat_id: userRecord.telegram_chat_id ? '✅ presente' : '❌ ausente',
    };

    // Tenta Expo
    if (userRecord.push_token) {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: userRecord.push_token,
          title: '⏰ Teste',
          body: message || 'Notificação de teste',
          sound: 'default',
        }),
      });
      const json = await res.json();
      result.expo_result = json;
    }

    // Tenta Telegram
    if (userRecord.telegram_chat_id) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (botToken) {
        const res = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: userRecord.telegram_chat_id,
              text: `⏰ Teste\n${message || 'Notificação de teste'}`,
            }),
          }
        );
        const json = await res.json();
        result.telegram_result = json;
      } else {
        result.telegram_result = '❌ TELEGRAM_BOT_TOKEN ausente';
      }
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}