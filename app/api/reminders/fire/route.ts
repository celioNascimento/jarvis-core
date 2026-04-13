// app/api/reminders/fire/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { supabase } from '@/lib/jarvis';

// Verifica assinatura do QStash — garante que só o QStash pode chamar este endpoint
async function handler(req: NextRequest) {
  try {
    const body = await req.json() as {
      reminderId: string;
      userId: string;
      authUserId: string;
      message: string;
      scheduledTime: string;
    };

    const { reminderId, userId, authUserId, message } = body;

    console.log('[reminders/fire] Recebido:', reminderId, '— user:', userId);

    // 1. Busca o lembrete no banco para confirmar que ainda existe e não foi cancelado
    const { data: reminder, error } = await supabase
      .from('reminders')
      .select('*')
      .eq('id', reminderId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !reminder) {
      console.warn('[reminders/fire] Lembrete não encontrado ou já removido:', reminderId);
      return NextResponse.json({ ok: true, skipped: true });
    }

    if (reminder.fired) {
      console.warn('[reminders/fire] Lembrete já disparado anteriormente:', reminderId);
      return NextResponse.json({ ok: true, skipped: true });
    }

    if (reminder.cancelled) {
      console.warn('[reminders/fire] Lembrete cancelado:', reminderId);
      return NextResponse.json({ ok: true, skipped: true });
    }

    // 2. Busca o push token do usuário
    const { data: userRecord } = await supabase
      .from('users')
      .select('expo_push_token, telegram_chat_id, nickname')
      .eq('id', userId)
      .maybeSingle();

    if (!userRecord) {
      console.error('[reminders/fire] Usuário não encontrado:', userId);
      return NextResponse.json({ ok: false, error: 'user_not_found' }, { status: 404 });
    }

    let notified = false;

    // 3a. Notificação via Expo Push
    if (userRecord.expo_push_token) {
      const expoPushRes = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: userRecord.expo_push_token,
          title: '⏰ Lembrete',
          body: reminder.message || message,
          data: { reminderId },
          sound: 'default',
        }),
      });
      if (expoPushRes.ok) {
        notified = true;
        console.log('[reminders/fire] Push Expo enviado para:', userRecord.expo_push_token);
      } else {
        console.error('[reminders/fire] Falha no push Expo:', await expoPushRes.text());
      }
    }

    // 3b. Fallback via Telegram
    if (!notified && userRecord.telegram_chat_id) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (botToken) {
        const telegramRes = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: userRecord.telegram_chat_id,
              text: `⏰ *Lembrete*\n${reminder.message || message}`,
              parse_mode: 'Markdown',
            }),
          }
        );
        if (telegramRes.ok) {
          notified = true;
          console.log('[reminders/fire] Telegram enviado para:', userRecord.telegram_chat_id);
        } else {
          console.error('[reminders/fire] Falha no Telegram:', await telegramRes.text());
        }
      }
    }

    // 4. Marca como disparado
    await supabase
      .from('reminders')
      .update({ fired: true, fired_at: new Date().toISOString() })
      .eq('id', reminderId);

    console.log('[reminders/fire] Concluído — notified:', notified);
    return NextResponse.json({ ok: true, notified });

  } catch (err) {
    console.error('[reminders/fire] Erro interno:', err);
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}

// Exporta com verificação de assinatura do QStash
export const POST = verifySignatureAppRouter(handler);