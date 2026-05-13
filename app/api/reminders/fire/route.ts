// app/api/reminders/fire/route.ts
export const runtime = 'edge';
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

    const isValid = await receiver.verify({ signature, body: bodyText }).catch(() => false);
    if (!isValid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const payload = JSON.parse(bodyText);
    const { reminderId, userId, message } = payload;

    // 1. Busca dados do Lembrete + Dono + Compartilhamentos (Schema JARVIS)
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

    // 2. Monta Lista de Destinatários (Dono + Shares Ativos)
    const recipients: any[] = [];
    if (reminder.users) recipients.push(reminder.users);
    
    reminder.reminder_shares?.forEach((share: any) => {
      if (share.active && share.shared_with) {
        recipients.push(share.shared_with);
      }
    });

    // 3. Disparo em Massa via Expo Push
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
        await expo.sendPushNotificationsAsync(chunk).catch(console.error);
      }
    }

    // 4. Atualização de Status Inteligente
    // Se for recorrente, não marcamos como 'completed' para não sumir da UI
    const isRecurring = reminder.type === 'recurring';
    const newStatus = isRecurring ? 'pending' : 'completed';

    await supabase
      .schema('jarvis')
      .from('reminders')
      .update({ 
        status: newStatus,
        fired: true,
        fired_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', reminderId);

    return NextResponse.json({ ok: true, notifiedCount: recipients.length });

  } catch (err) {
    console.error('[Fire] Erro crítico:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
