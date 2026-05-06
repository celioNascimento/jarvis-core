// app/api/geo/reminders/route.ts
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { sendPushNotification } from '@/lib/notifications/push';

export async function POST(req: Request) {
  try {
    const { userId, lat, lng } = await req.json();

    if (!userId || lat === undefined || lng === undefined) {
      return NextResponse.json({ error: 'Dados incompletos' }, { status: 400 });
    }

    // ── O PULO DO GATO: UMA CHAMADA SÓ ──
    // O banco calcula a distância de todos os lembretes de uma vez
    const { data: triggeredReminders, error } = await supabase
      .rpc('check_and_trigger_reminders', {
        p_user_id: parseInt(userId, 10),
        p_lat: lat,
        p_lng: lng
      });

    if (error) throw error;

    if (!triggeredReminders || triggeredReminders.length === 0) {
      return NextResponse.json({ triggered: 0 });
    }

    // Disparar as notificações em paralelo
    const triggerPromises = triggeredReminders.map(async (rem: any) => {
      await sendPushNotification(parseInt(userId, 10), rem.reminder_title);
      
      // Atualiza o status para disparado
      return supabase
        .from('reminders')
        .update({ status: 'triggered', updated_at: new Date().toISOString() })
        .eq('id', rem.reminder_id);
    });

    await Promise.all(triggerPromises);

    return NextResponse.json({ triggered: triggeredReminders.length });

  } catch (e: any) {
    console.error('[Geo/Reminders] Erro:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
