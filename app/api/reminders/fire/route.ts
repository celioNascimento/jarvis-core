// app/api/reminders/fire/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { supabase } from '@/lib/jarvis';

async function handler(req: NextRequest) {
  try {
    const body = await req.json() as {
      reminderId: string;
      userId: string;
      authUserId: string;
      message: string;
      scheduledTime: string;
    };

    const { reminderId, userId, message } = body;
    console.log('[reminders/fire] Recebido:', reminderId, '— user:', userId);

    // 1. Confirma que o lembrete existe e ainda está pendente
    const { data: reminder, error } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select('id, title, status')
      .eq('id', reminderId)
      .eq('user_id', Number(userId))
      .maybeSingle();

    if (error || !reminder) {
      console.warn('[reminders/fire] Lembrete não encontrado:', reminderId);
      return NextResponse.json({ ok: true, skipped: true, reason: 'not_found' });
    }

    if (reminder.status !== 'pending') {
      console.warn('[reminders/fire] Lembrete não está pendente:', reminder.status);
      return NextResponse.json({ ok: true, skipped: true, reason: reminder.status });
    }

    // 2. Busca dados de notificação — schema jarvis + coluna push_token
    const { data: userRecord } = await supabase
      .schema('jarvis')
      .from('users')
      .select('push_token, telegram_chat_id, nickname')
      .eq('id', Number(userId))
      .maybeSingle();

    if (!userRecord) {
      console.error('[reminders/fire] Usuário não encontrado:', userId);
      await supabase
        .schema('jarvis')
        .from('reminders')
        .update({ status: 'failed' })
        .eq('id', reminderId);
      return NextResponse.json({ ok: false, error: 'user_not_found' }, { status: 404 });
    }

    const reminderText = reminder.title || message;
    let notified = false;

    // 3a. Notificação via Expo Push
    if (userRecord.push_token) {
      try {
        const expoPushRes = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: userRecord.push_token,
            title: '⏰ Lembrete',
            body: reminderText,
            data: { reminderId },
            sound: 'default',
          }),
        });
        const expoJson = await expoPushRes.json();
        console.log('[reminders/fire] Expo response:', JSON.stringify(expoJson));
        if (expoJson?.data?.status === 'ok') {
          notified = true;
        } else {
          console.error('[reminders/fire] Expo erro:', expoJson?.data?.message);
        }
      } catch (err) {
        console.error('[reminders/fire] Erro no push Expo:', err);
      }
    }

    // 3b. Fallback via Telegram
    if (!notified && userRecord.telegram_chat_id) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (botToken) {
        try {
          const telegramRes = await fetch(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: userRecord.telegram_chat_id,
                text: `⏰ *Lembrete*\n${reminderText}`,
                parse_mode: 'Markdown',
              }),
            }
          );
          if (telegramRes.ok) {
            notified = true;
            console.log('[reminders/fire] Telegram enviado');
          }
        } catch (err) {
          console.error('[reminders/fire] Erro no Telegram:', err);
        }
      }
    }

    // 4. Atualiza status
    await supabase
      .schema('jarvis')
      .from('reminders')
      .update({ status: notified ? 'triggered' : 'failed' })
      .eq('id', reminderId);

    console.log('[reminders/fire] Concluído — status:', notified ? 'triggered' : 'failed');
    return NextResponse.json({ ok: true, notified, status: notified ? 'triggered' : 'failed' });

  } catch (err) {
    console.error('[reminders/fire] Erro interno:', err);
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}

export const POST = verifySignatureAppRouter(handler);