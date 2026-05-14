// ============================================================
// app/api/reminders/fire/route.ts
// Motor V8.3.0 — Pure Edge (Sem dependências Node:Module)
// ============================================================
export const runtime = 'edge'; 

import { NextRequest, NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { supabase } from '@/lib/jarvis';

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
});

// Helper para chunking manual (Expo aceita até 100 por request)
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export async function POST(req: NextRequest) {
  try {
    const bodyText = await req.text();
    const signature = req.headers.get('upstash-signature') ?? '';

    // 1. Validação QStash
    const isValid = await receiver.verify({ signature, body: bodyText }).catch(() => false);
    if (!isValid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const payload = JSON.parse(bodyText);
    const { reminderId, message } = payload;

    // 2. Busca Reminders + Shares (Schema JARVIS)
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

    if (remError || !reminder) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    // 3. Destinatários
    const recipients: any[] = [];
    if (reminder.users) recipients.push(reminder.users);
    reminder.reminder_shares?.forEach((s: any) => {
      if (s.active && s.shared_with) recipients.push(s.shared_with);
    });

    // 4. Disparo via Fetch Nativo (Edge Safe)
    const pushPayloads = recipients
      .filter(r => r.push_token)
      .map(r => ({
        to: r.push_token,
        title: '📅 Lembrete Jarvis',
        body: message,
        sound: 'default',
        data: { reminderId, type: reminder.type },
      }));

    if (pushPayloads.length > 0) {
      const chunks = chunkArray(pushPayloads, 100);
      
      // Enviamos todos os chunks em paralelo para performance
      await Promise.all(chunks.map(chunk => 
        fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(chunk),
        })
      ));
    }

    // 5. Atualização de Status
    const isRecurring = reminder.type === 'recurring';
    await supabase
      .schema('jarvis')
      .from('reminders')
      .update({ 
        status: isRecurring ? 'pending' : 'completed',
        fired: true,
        fired_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', reminderId);

    return NextResponse.json({ ok: true, sent: pushPayloads.length });

  } catch (err: any) {
    console.error('[Fire Error]:', err.message);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
