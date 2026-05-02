// ============================================================
// app/api/calendar/events/[id]/route.ts
// GET    /api/calendar/events/[id]
// PUT    /api/calendar/events/[id]
// DELETE /api/calendar/events/[id]
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { scheduleReminderOnQStash, cancelReminderOnQStash } from '@/lib/qstash';

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

// Verifica se userId tem acesso ao evento (próprio ou compartilhado)
async function hasAccessToEvent(eventId: string, userId: bigint): Promise<{ allowed: boolean; event: any }> {
  const { data: event, error } = await supabase
    .schema('jarvis')
    .from('events')
    .select('*')
    .eq('id', eventId)
    .single();

  if (error || !event) return { allowed: false, event: null };

  // É o dono
  if (String(event.user_id) === String(userId)) return { allowed: true, event };

  // Verifica compartilhamento por categoria
  const { data: catShare } = await supabase
    .schema('jarvis')
    .from('calendar_shares')
    .select('id')
    .eq('owner_id', event.user_id)
    .eq('shared_with_id', userId)
    .eq('category', event.category)
    .maybeSingle();

  if (catShare) return { allowed: true, event };

  // Verifica compartilhamento por evento específico
  const { data: eventShare } = await supabase
    .schema('jarvis')
    .from('calendar_event_shares')
    .select('id')
    .eq('event_id', eventId)
    .eq('shared_with_id', userId)
    .maybeSingle();

  if (eventShare) return { allowed: true, event };

  return { allowed: false, event };
}

// ── GET ─────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authUserId = req.headers.get('x-user-id');
  if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = await resolveUserId(authUserId);
  if (!userId) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const { id } = await params;

  const { allowed, event } = await hasAccessToEvent(id, userId);
  if (!allowed || !event) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ event });
}

// ── PUT ─────────────────────────────────────────────────────

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authUserId = req.headers.get('x-user-id');
  if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = await resolveUserId(authUserId);
  if (!userId) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const [{ id }, body] = await Promise.all([params, req.json()]);

  const { allowed } = await hasAccessToEvent(id, userId);
  if (!allowed) return NextResponse.json({ error: 'Sem permissão' }, { status: 403 });

  await cancelPendingReminders(id);

  // PUT sem .eq('user_id') pois o acesso já foi validado acima
  const { data: event, error } = await supabase
    .schema('jarvis')
    .from('events')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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
  { params }: { params: Promise<{ id: string }> }
) {
  const authUserId = req.headers.get('x-user-id');
  if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = await resolveUserId(authUserId);
  if (!userId) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const { id } = await params;

  const { allowed } = await hasAccessToEvent(id, userId);
  if (!allowed) return NextResponse.json({ error: 'Sem permissão' }, { status: 403 });

  await cancelPendingReminders(id);

  const { error } = await supabase
    .schema('jarvis')
    .from('events')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}