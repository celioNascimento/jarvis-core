// ============================================================
// app/api/reminders/route.ts
// Motor V8.16.0 — CRUD Híbrido com QStash (Schema Jarvis)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { scheduleReminderOnQStash, cancelReminderOnQStash } from '@/lib/qstash';

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
    // 1. Lembretes próprios
    const { data: ownReminders, error: ownError } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select('*')
      .eq('user_id', user!.id)
      .order('scheduled_time', { ascending: true, nullsFirst: false });

    if (ownError) throw ownError;

    // 2. Lembretes compartilhados (se houver)
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
    console.error('[Reminders GET Error]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── POST: CRIAR NOVO LEMBRETE E AGENDAR NO QSTASH ───────────────────────────
export async function POST(req: NextRequest) {
  const { user, authUser, error, status } = await getJarvisUser(req);
  if (error) return NextResponse.json({ error }, { status });

  try {
    const body = await req.json();

    // 1. Salva no banco de dados primeiro
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

    // 2. Agenda no QStash (se houver horário e não for puramente por localização)
    if (reminder.scheduled_time && reminder.type !== 'location') {
      const qstashId = await scheduleReminderOnQStash({
        reminderId: reminder.id, // ID agora é UUID
        userId: user!.id.toString(), // ID do schema jarvis
        authUserId: authUser!.id, // UUID de autenticação
        message: reminder.title,
        scheduledTime: reminder.scheduled_time,
        cron: body.cron || null, // Recebe do payload caso seja recorrente nativo do QStash
      });

      // 3. Atualiza o ID da mensagem do QStash no banco
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
    console.error('[Reminders POST Error]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── PUT: ATUALIZAR LEMBRETE E REAGENDAR NO QSTASH ───────────────────────────
export async function PUT(req: NextRequest) {
  const { user, authUser, error, status } = await getJarvisUser(req);
  if (error) return NextResponse.json({ error }, { status });

  try {
    const body = await req.json();
    const { id, cron, ...updateData } = body;

    if (!id) return NextResponse.json({ error: 'ID do lembrete obrigatório' }, { status: 400 });

    // 1. Busca o lembrete atual para validar propriedade e pegar o QStash ID antigo
    const { data: oldReminder } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select('user_id, qstash_message_id, type')
      .eq('id', id)
      .single();

    if (!oldReminder || oldReminder.user_id !== user!.id) {
      return NextResponse.json({ error: 'Sem permissão' }, { status: 403 });
    }

    // 2. Cancela o agendamento antigo no QStash (se existir)
    if (oldReminder.qstash_message_id && (updateData.scheduled_time || updateData.status !== 'pending')) {
      await cancelReminderOnQStash(oldReminder.qstash_message_id);
      updateData.qstash_message_id = null; // Limpa para garantir
    }

    // 3. Atualiza os dados no banco
    const { data: updatedReminder, error: updateError } = await supabase
      .schema('jarvis')
      .from('reminders')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    // 4. Se continuou pendente e tem horário, cria um novo agendamento no QStash
    if (updatedReminder.status === 'pending' && updatedReminder.scheduled_time && updatedReminder.type !== 'location') {
      const qstashId = await scheduleReminderOnQStash({
        reminderId: updatedReminder.id,
        userId: user!.id.toString(),
        authUserId: authUser!.id,
        message: updatedReminder.title,
        scheduledTime: updatedReminder.scheduled_time,
        cron: cron || null,
      });

      if (qstashId) {
        await supabase
          .schema('jarvis')
          .from('reminders')
          .update({ qstash_message_id: qstashId })
          .eq('id', updatedReminder.id);
          
        updatedReminder.qstash_message_id = qstashId;
      }
    }

    return NextResponse.json({ ok: true, reminder: updatedReminder });
  } catch (e: any) {
    console.error('[Reminders PUT Error]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── DELETE: CANCELAR NO QSTASH E EXCLUIR DO BANCO ───────────────────────────
export async function DELETE(req: NextRequest) {
  const { user, error, status } = await getJarvisUser(req);
  if (error) return NextResponse.json({ error }, { status });

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) return NextResponse.json({ error: 'ID do lembrete obrigatório' }, { status: 400 });

    // 1. Busca o lembrete para validação e extração do QStash ID
    const { data: reminder } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select('user_id, qstash_message_id')
      .eq('id', id)
      .single();

    if (!reminder || reminder.user_id !== user!.id) {
      return NextResponse.json({ error: 'Sem permissão' }, { status: 403 });
    }

    // 2. Remove o agendamento pendente no QStash
    if (reminder.qstash_message_id) {
      await cancelReminderOnQStash(reminder.qstash_message_id);
    }

    // 3. Deleta o registro do banco
    const { error: deleteError } = await supabase
      .schema('jarvis')
      .from('reminders')
      .delete()
      .eq('id', id);

    if (deleteError) throw deleteError;

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[Reminders DELETE Error]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
