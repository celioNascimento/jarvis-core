// ============================================================
// app/api/reminders/route.ts
// Motor V8.17.0 — CRUD Híbrido com QStash e Automação de Cron
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { 
  scheduleReminderOnQStash, 
  cancelReminderOnQStash, 
  frequencyToCron 
} from '@/lib/qstash';

// ── HELPER DE AUTENTICAÇÃO DRY ──────────────────────────────────────────────
async function getJarvisUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { error: 'Não autorizado', status: 401 };

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) return { error: 'Não autorizado', status: 401 };

  const { data: userProfile } = await supabase
    .schema('jarvis')
    .from('users')
    .select('id, auth_user_id')
    .eq('auth_user_id', authData.user.id)
    .single();

  if (!userProfile) return { error: 'Perfil não encontrado', status: 404 };

  return { user: userProfile, authUser: authData.user };
}

// ── GET: BUSCAR LEMBRETES ───────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { user, error, status } = await getJarvisUser(req);
  if (error) return NextResponse.json({ error }, { status });

  try {
    const { data: ownReminders, error: ownError } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select('*')
      .eq('user_id', user!.id)
      .order('scheduled_time', { ascending: true, nullsFirst: false });

    if (ownError) throw ownError;

    const { data: shares } = await supabase
      .schema('jarvis')
      .from('reminder_shares')
      .select('reminder_id')
      .eq('shared_with_id', user!.id)
      .eq('active', true);

    const sharedIds = (shares ?? []).map(s => s.reminder_id);
    let sharedReminders: any[] = [];

    if (sharedIds.length > 0) {
      const { data, error: sharedError } = await supabase
        .schema('jarvis')
        .from('reminders')
        .select('*')
        .in('id', sharedIds)
        .eq('status', 'pending')
        .order('scheduled_time', { ascending: true, nullsFirst: false });

      if (sharedError) throw sharedError;
      sharedReminders = (data ?? []).map(r => ({ ...r, shared_from_partner: true }));
    }

    const all = [...(ownReminders ?? []), ...sharedReminders].sort((a, b) => {
      if (!a.scheduled_time) return 1;
      if (!b.scheduled_time) return -1;
      return new Date(a.scheduled_time).getTime() - new Date(b.scheduled_time).getTime();
    });

    return NextResponse.json({ ok: true, reminders: all });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── POST: CRIAR E AGENDAR ───────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { user, authUser, error, status } = await getJarvisUser(req);
  if (error) return NextResponse.json({ error }, { status });

  try {
    const body = await req.json();

    const { data: reminder, error: dbError } = await supabase
      .schema('jarvis')
      .from('reminders')
      .insert({
        user_id: user!.id,
        title: body.title,
        type: body.type || 'temporary',
        scheduled_time: body.scheduled_time || null,
        frequency: body.frequency || null,
        location_trigger: body.location_trigger || null,
        status: 'pending'
      })
      .select()
      .single();

    if (dbError) throw dbError;

    // ── AUTOMAÇÃO: Cálculo de Cron e Agendamento ──
    if (reminder.scheduled_time && reminder.type !== 'location') {
      const cronCalculado = reminder.frequency 
        ? frequencyToCron(reminder.frequency, reminder.scheduled_time) 
        : null;

      const qstashId = await scheduleReminderOnQStash({
        reminderId: reminder.id,
        userId: user!.id.toString(),
        authUserId: authUser!.id,
        message: reminder.title,
        scheduledTime: reminder.scheduled_time,
        cron: cronCalculado, // Injeta o cron automático aqui
      });

      if (qstashId) {
        await supabase
          .schema('jarvis')
          .from('reminders')
          .update({ qstash_message_id: qstashId })
          .eq('id', reminder.id);
          
        reminder.qstash_message_id = qstashId;
      }
    }

    return NextResponse.json({ ok: true, reminder });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── PUT: ATUALIZAR E REAGENDAR ──────────────────────────────────────────────
export async function PUT(req: NextRequest) {
  const { user, authUser, error, status } = await getJarvisUser(req);
  if (error) return NextResponse.json({ error }, { status });

  try {
    const body = await req.json();
    const { id, ...updateData } = body;

    if (!id) return NextResponse.json({ error: 'ID obrigatório' }, { status: 400 });

    const { data: old } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select('user_id, qstash_message_id')
      .eq('id', id)
      .single();

    if (!old || old.user_id !== user!.id) {
      return NextResponse.json({ error: 'Sem permissão' }, { status: 403 });
    }

    // ── LIMPEZA: Cancela agendamento antigo no QStash ──
    if (old.qstash_message_id) {
      await cancelReminderOnQStash(old.qstash_message_id);
    }

    const { data: updated, error: upError } = await supabase
      .schema('jarvis')
      .from('reminders')
      .update({ ...updateData, qstash_message_id: null }) // Limpa ID antigo
      .eq('id', id)
      .select()
      .single();

    if (upError) throw upError;

    // ── REAGENDAMENTO: Novo tempo ou frequência ──
    if (updated.status === 'pending' && updated.scheduled_time && updated.type !== 'location') {
      const cronCalculado = updated.frequency 
        ? frequencyToCron(updated.frequency, updated.scheduled_time) 
        : null;

      const qstashId = await scheduleReminderOnQStash({
        reminderId: updated.id,
        userId: user!.id.toString(),
        authUserId: authUser!.id,
        message: updated.title,
        scheduledTime: updated.scheduled_time,
        cron: cronCalculado,
      });

      if (qstashId) {
        await supabase
          .schema('jarvis')
          .from('reminders')
          .update({ qstash_message_id: qstashId })
          .eq('id', updated.id);
          
        updated.qstash_message_id = qstashId;
      }
    }

    return NextResponse.json({ ok: true, reminder: updated });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── DELETE: CANCELAR E REMOVER ──────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const { user, error, status } = await getJarvisUser(req);
  if (error) return NextResponse.json({ error }, { status });

  try {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'ID obrigatório' }, { status: 400 });

    const { data: rem } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select('user_id, qstash_message_id')
      .eq('id', id)
      .single();

    if (!rem || rem.user_id !== user!.id) {
      return NextResponse.json({ error: 'Sem permissão' }, { status: 403 });
    }

    if (rem.qstash_message_id) {
      await cancelReminderOnQStash(rem.qstash_message_id);
    }

    await supabase.schema('jarvis').from('reminders').delete().eq('id', id);

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
