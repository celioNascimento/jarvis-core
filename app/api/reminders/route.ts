// ============================================================
// app/api/reminders/fire/route.ts
// Motor V8.2.1 — Disparo com Node.js Runtime (Compatível com Expo SDK)
// ============================================================

// Alteramos para 'nodejs' ou removemos a linha, pois Node é o default.
export const runtime = 'nodejs'; 

import { NextRequest, NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { supabase } from '@/lib/jarvis';
import { Expo } from 'expo-server-sdk';

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
});

const expo = new Expo();

export async function POST(req: NextRequest) {
  try {
    const bodyText = await req.text();
    const signature = req.headers.get('upstash-signature') ?? '';

    // 1. Validação de segurança do QStash
    const isValid = await receiver.verify({ signature, body: bodyText }).catch(() => false);
    if (!isValid) {
      console.error('[Fire] Assinatura QStash inválida.');
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    const payload = JSON.parse(bodyText);
    const { reminderId, message } = payload;

    // 2. Busca dados do Lembrete + Dono + Compartilhamentos
    const { data: reminder, error: remError } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select(`
        id, type, 
        users!fk_reminders_user (push_token, telegram_chat_id),
        reminder_shares (
          active,
          shared_with:users!reminder_shares_shared_with_id_fkey (push_token, telegram_chat_id)
        )
      `)
      .eq('id', reminderId)
      .single();

    if (remError || !reminder) {
      return NextResponse.json({ error: 'reminder_not_found' }, { status: 404 });
    }

    // 3. Organiza destinatários
    const recipients: any[] = [];
    if (reminder.users) recipients.push(reminder.users);
    
    reminder.reminder_shares?.forEach((share: any) => {
      if (share.active && share.shared_with) {
        recipients.push(share.shared_with);
      }
    });

    // 4. Disparo Push via Expo SDK (Agora seguro no Node.js)
    const pushMessages = recipients
      .filter(r => r.push_token && Expo.isExpoPushToken(r.push_token))
      .map(r => ({
        to: r.push_token,
        title: '📅 Lembrete Jarvis',
        body: message,
        sound: 'default',
        data: { reminderId, type: reminder.type },
      }));

    if (pushMessages.length > 0) {
      const chunks = expo.chunkPushNotifications(pushMessages);
      for (const chunk of chunks) {
        try {
          await expo.sendPushNotificationsAsync(chunk);
        } catch (pushErr) {
          console.error('[Fire] Erro ao enviar chunk de push:', pushErr);
        }
      }
    }

    // 5. Lógica de Fallback Telegram (Opcional, mas recomendado)
    // Se quiser manter o Telegram como redundância, o código segue aqui...

    // 6. Atualização de Status
    const isRecurring = reminder.type === 'recurring';
    const { error: updateError } = await supabase
      .schema('jarvis')
      .from('reminders')
      .update({ 
        status: isRecurring ? 'pending' : 'completed',
        fired: true,
        fired_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', reminderId);

    if (updateError) console.error('[Fire] Erro ao atualizar status:', updateError.message);

    return NextResponse.json({ ok: true, sentTo: recipients.length });

  } catch (err) {
    console.error('[Fire] Erro crítico no motor:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
