// app/api/reminders/fire/route.ts
// Motor V8.5.0 — Consultas lineares seguras + Unswallowed Errors

export const runtime = 'edge';

import { NextRequest, NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { supabase } from '@/lib/jarvis';

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
  nextSigningKey:    process.env.QSTASH_NEXT_SIGNING_KEY!,
});

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export async function POST(req: NextRequest) {
  try {
    const bodyText = await req.text();
    const signature = req.headers.get('upstash-signature') ?? '';

    // 1. Validação do QStash
    const isValid = await receiver.verify({ signature, body: bodyText }).catch(() => false);
    if (!isValid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const payload = JSON.parse(bodyText);
    const { reminderId, message } = payload;

    // 2. Consulta 1: Busca o lembrete de forma atômica
    const { data: reminder, error: remError } = await supabase
      .from('reminders')
      .select('id, type, status, user_id')
      .eq('id', reminderId)
      .maybeSingle();

    // Proteção contra erros de banco reais (unswallowed)
    if (remError) {
      console.error('[ReminderFire] Erro de infraestrutura no Supabase:', remError.message);
      return NextResponse.json({ error: 'database_error', details: remError.message }, { status: 500 });
    }

    if (!reminder) {
      console.error('[ReminderFire] Lembrete realmente não existe no banco:', reminderId);
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // 3. Guard — Se o usuário cancelou no chat, interrompe o disparo imediatamente
    if (reminder.status === 'cancelled') {
      console.log(`[ReminderFire] Lembrete ${reminderId} já estava cancelado — disparo ignorado`);
      return NextResponse.json({ ok: true, skipped: true });
    }

    // 4. Coleta de Destinatários de forma linear (Owner + Shares)
    const recipients: any[] = [];

    // Consulta 2: Dados de Push do Dono do Lembrete
    const { data: ownerUser } = await supabase
      .from('users')
      .select('push_token, telegram_chat_id')
      .eq('id', reminder.user_id)
      .maybeSingle();

    if (ownerUser) recipients.push(ownerUser);

    // Consulta 3: Vínculos e compartilhamentos ativos
    const { data: shares } = await supabase
      .from('reminder_shares')
      .select('shared_with_id')
      .eq('reminder_id', reminderId)
      .eq('active', true);

    const sharedUserIds = shares?.map(s => s.shared_with_id) || [];

    if (sharedUserIds.length > 0) {
      const { data: sharedUsers } = await supabase
        .from('users')
        .select('push_token, telegram_chat_id')
        .in('id', sharedUserIds);
      
      if (sharedUsers) {
        recipients.push(...sharedUsers);
      }
    }

    // 5. Preparação e disparo do Push Expo (Edge-safe fetch)
    const pushPayloads = recipients
      .filter(r => r.push_token)
      .map(r => ({
        to:    r.push_token,
        title: '📅 Lembrete Jarvis',
        body:  message,
        sound: 'default',
        data:  { reminderId, type: reminder.type },
      }));

    if (pushPayloads.length > 0) {
      const chunks = chunkArray(pushPayloads, 100);
      await Promise.all(
        chunks.map(chunk =>
          fetch('https://exp.host/--/api/v2/push/send', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(chunk),
          })
        )
      );
    }

    // 6. Atualização de status em conformidade com as regras do banco
    const isRecurring = reminder.type === 'recurring';
    
    await supabase
      .from('reminders')
      .update({
        status:     isRecurring ? 'pending' : 'triggered',
        fired:      true,
        fired_at:   new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', reminderId);

    console.log(`[ReminderFire] Sucesso — ${pushPayloads.length} push(es) enviado(s) para o lembrete ${reminderId}`);
    return NextResponse.json({ ok: true, sent: pushPayloads.length });

  } catch (err: any) {
    console.error('[ReminderFire] Erro crítico na execução da rota:', err.message);
    return NextResponse.json({ error: 'internal_error', msg: err.message }, { status: 500 });
  }
}