// ============================================================
// app/api/calendar/events/[id]/route.ts
// GET    /api/calendar/events/[id]
// PUT    /api/calendar/events/[id]
// DELETE /api/calendar/events/[id]
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  scheduleReminderOnQStash,
  cancelReminderOnQStash,
} from '@/lib/qstash';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function resolveUserId(authUserId: string): Promise<bigint | null> {
  const { data } = await supabase
    .schema('jarvis')
    .from('users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .single();
  return data?.id ?? null;
}

async function cancelPendingReminders(eventId: string) {
  const { data: reminders } = await supabase
    .schema('jarvis')
    .from('event_reminders')
    .select('id, qstash_message_id')
    .eq('event_id', eventId)
    .eq('status', 'pending');

  if (!reminders?.length) return;

  for (const r of reminders) {
    if (r.qstash_message_id) {
      await cancelReminderOnQStash(r.qstash_message_id);
    }
  }

  await supabase
    .schema('jarvis')
    .from('event_reminders')
    .update({ status: 'cancelled' })
    .eq('event_id', eventId)
    .eq('status', 'pending');
}

// ── GET ─────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const authUserId = req.headers.get('x-user-id');
  if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: event, error } = await supabase
    .schema('jarvis')
    .from('events')
    .select('*')
    .eq('id', params.id)
    .single();

  if (error || !event) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ event });
}

// ── PUT ─────────────────────────────────────────────────────

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const authUserId = req.headers.get('x-user-id');
  if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = await resolveUserId(authUserId);
  if (!userId) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const body = await req.json();

  // Cancela lembretes antigos antes de recriar
  await cancelPendingReminders(params.id);

  const { data: event, error } = await supabase
    .schema('jarvis')
    .from('events')
    .update({
      ...body,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Reagenda lembretes se houver
  if (body.reminder_minutes?.length) {
    for (const reminder of body.reminder_minutes) {
      const scheduledAt = new Date(
        new Date(event.start_at).getTime() - reminder * 60_000
      );
      if (scheduledAt > new Date()) {
        const messageId = await scheduleReminderOnQStash({
          reminderId:    event.id,
          userId:        String(userId),
          authUserId,
          message:       `Lembrete: ${event.title}`,
          scheduledTime: scheduledAt.toISOString(),
        });
        if (messageId) {
          await supabase
            .schema('jarvis')
            .from('event_reminders')
            .update({ qstash_message_id: messageId })
            .eq('event_id', event.id)
            .eq('minutes_before', reminder)
            .eq('status', 'pending');
        }
      }
    }
  }

  return NextResponse.json({ event });
}

// ── DELETE ───────────────────────────────────────────────────

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const authUserId = req.headers.get('x-user-id');
  if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = await resolveUserId(authUserId);
  if (!userId) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  // Cancela lembretes pendentes no QStash
  await cancelPendingReminders(params.id);

  const { error } = await supabase
    .schema('jarvis')
    .from('events')
    .delete()
    .eq('id', params.id)
    .eq('user_id', userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}