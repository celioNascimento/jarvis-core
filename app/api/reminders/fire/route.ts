// ============================================================
// app/api/reminders/fire/route.ts
// Motor V8.13.0 — Disparo de Lembretes Híbridos com Segurança QStash
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { createClient } from '@supabase/supabase-js';

// Usamos o service_role para garantir que o webhook consiga atualizar 
// a tabela mesmo sem o token de autenticação do front-end
const supabaseFire = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function handler(req: NextRequest) {
  try {
    const payload = await req.json();
    const { reminderId, userId, message } = payload;

    console.log('[reminders/fire] Recebido:', reminderId, '— user:', userId);

    // 1. Marca como disparado na nova tabela da V8.13.0
    const { error: updateError } = await supabaseFire
      .schema('jarvis')
      .from('event_reminders')
      .update({ status: 'fired', fired_at: new Date().toISOString() })
      .eq('id', reminderId);

    if (updateError) {
      console.error('[reminders/fire] Erro ao atualizar status no BD:', updateError.message);
    }

    // 2. Busca os tokens do usuário (Cobre a nomenclatura antiga e a nova)
    const { data: userRow } = await supabaseFire
      .schema('jarvis')
      .from('users')
      .select('expo_push_token, push_token, telegram_chat_id')
      .eq('id', userId)
      .single();

    if (!userRow) {
      console.error('[reminders/fire] Usuário não encontrado:', userId);
      return NextResponse.json({ ok: false, error: 'user_not_found' }, { status: 404 });
    }

    let notified = false;
    const activePushToken = userRow.expo_push_token || userRow.push_token;

    // 3a. Disparo via Expo Push
    if (activePushToken) {
      try {
        const expoPushRes = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: activePushToken,
            title: '📅 Lembrete',
            body: message,
            data: { reminderId, type: 'event_reminder' },
            sound: 'default',
          }),
        });
        const expoJson = await expoPushRes.json();
        
        if (expoJson?.data?.status === 'ok') {
          notified = true;
          console.log('[reminders/fire] Push Expo enviado.');
        } else {
          console.error('[reminders/fire] Erro retornado pelo Expo:', expoJson?.data?.message);
        }
      } catch (err) {
        console.error('[reminders/fire] Falha de rede no push Expo:', err);
      }
    }

    // 3b. Fallback via Telegram (Se o Push falhar ou não existir)
    if (!notified && userRow.telegram_chat_id) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (botToken) {
        try {
          const telegramRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: userRow.telegram_chat_id,
              text: `📅 *Lembrete*\n${message}`,
              parse_mode: 'Markdown',
            }),
          });
          
          if (telegramRes.ok) {
            notified = true;
            console.log('[reminders/fire] Telegram enviado com sucesso.');
          }
        } catch (err) {
          console.error('[reminders/fire] Erro no disparo Telegram:', err);
        }
      }
    }

    return NextResponse.json({ ok: true, notified });

  } catch (err) {
    console.error('[reminders/fire] Erro crítico interno:', err);
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}

// O QStash exige que a função seja encapsulada para validar a assinatura e bloquear invasores
export const POST = verifySignatureAppRouter(handler);