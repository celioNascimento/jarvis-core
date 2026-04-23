// ============================================================
// app/api/reminders/fire/route.ts
// Motor V8.13.0 — Disparo de Lembretes Híbridos com Segurança QStash
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { supabase } from '@/lib/jarvis'; 

// Instanciamos o Receiver manualmente para usar o verify()
const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
});

export async function POST(req: NextRequest) {
  try {
    // 1. Lê o stream UMA única vez como texto
    const bodyText = await req.text();
    const signature = req.headers.get('upstash-signature') ?? '';

    // 2. Validação manual de segurança do QStash
    const isValid = await receiver.verify({
      signature,
      body: bodyText,
    }).catch(() => false);

    if (!isValid) {
      console.error('[reminders/fire] Acesso negado: Assinatura inválida');
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    // 3. Parse seguro do JSON que já está em memória
    const payload = JSON.parse(bodyText);
    const { reminderId, userId, message } = payload;

    console.log('[reminders/fire] Recebido e validado:', { reminderId, userId, message });

    // 4. Atualiza status e marcos de disparo na tabela reminders
    const { error: reminderError } = await supabase
      .from('reminders')
      .update({ 
        status: 'completed', 
        fired: true, 
        fired_at: new Date().toISOString(),
        updated_at: new Date().toISOString() 
      })
      .eq('id', reminderId);
      
    if (reminderError) {
      console.error('[reminders/fire] Erro ao atualizar BD:', reminderError.message);
    }

    // 5. Busca os tokens do usuário garantindo o tipo Numérico
    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('push_token, telegram_chat_id')
      .eq('id', Number(userId))
      .single();

    if (userError || !userRow) {
      console.error('[reminders/fire] Usuário não encontrado:', userId);
      return NextResponse.json({ ok: false, error: 'user_not_found' }, { status: 404 });
    }

    let notified = false;
    const activePushToken = userRow.push_token;

    // 6a. Disparo via Expo Push
    if (activePushToken) {
      try {
        const expoPushRes = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: activePushToken,
            title: '📅 Lembrete',
            body: message,
            data: { reminderId, type: 'reminder' },
            sound: 'default',
          }),
        });
        const expoJson = await expoPushRes.json();
        
        if (expoJson?.data?.status === 'ok') {
          notified = true;
          console.log('[reminders/fire] Push Expo enviado.');
        } else {
          console.error('[reminders/fire] Erro do Expo:', expoJson?.data?.message);
        }
      } catch (err) {
        console.error('[reminders/fire] Falha na API do Expo:', err);
      }
    }

    // 6b. Fallback via Telegram
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
          console.error('[reminders/fire] Erro na API do Telegram:', err);
        }
      }
    }

    return NextResponse.json({ ok: true, notified });

  } catch (err) {
    console.error('[reminders/fire] Erro crítico:', err);
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}