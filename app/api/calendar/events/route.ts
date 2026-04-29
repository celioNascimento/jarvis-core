// ============================================================
// app/api/calendar/events/route.ts
// GET  /api/calendar/events?from=&to=&category=
// POST /api/calendar/events
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

// ── helpers ─────────────────────────────────────────────────

async function resolveUserId(authUserId: string): Promise<bigint | null> {
  const { data } = await supabase
  .schema('jarvis')
  .from('users')
  .select('id')
  .eq('auth_user_id', authUserId)
  .single();
  return data?.id ?? null;
}

async function scheduleRemindersForEvent(
  eventId: string,
  userId: string,
  authUserId: string,
  eventTitle: string
) {
  // 1. Pede ao Supabase para recriar os lembretes pendentes
  const { data: reminders, error } = await supabase.rpc('upsert_event_reminders', {
    p_event_id: eventId,
  });

  if (error || !reminders?.length) return;

  // 2. Agenda cada lembrete no QStash e salva o messageId
  for (const reminder of reminders) {
    const messageId = await scheduleReminderOnQStash({
      reminderId:    reminder.reminder_id,
      userId,
      authUserId,
      message:       `Lembrete: ${eventTitle}`,
      scheduledTime: reminder.scheduled_at,
    });

    if (messageId) {
      await supabase
        .from('jarvis.event_reminders')
        .update({ qstash_message_id: messageId })
        .eq('id', reminder.reminder_id);
    }
  }
}

// ── GET ─────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const authUserId = req.headers.get('x-user-id');
  if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = await resolveUserId(authUserId);
  if (!userId) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const from     = searchParams.get('from');
  const to       = searchParams.get('to');
  const category = searchParams.get('category') ?? undefined;

  // Se não tiver range, usa próximos 30 dias
  const fromDate = from ? new Date(from) : new Date();
  const toDate   = to   ? new Date(to)   : new Date(Date.now() + 30 * 86400_000);

  const { data, error } = await supabase.rpc('get_events_in_range', {
    p_user_id:  userId,
    p_from:     fromDate.toISOString(),
    p_to:       toDate.toISOString(),
    p_category: category ?? null,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ events: data });
}

// ── POST ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const authUserId = req.headers.get('x-user-id');
  if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = await resolveUserId(authUserId);
  if (!userId) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const body = await req.json();
  const {
    title, description, location,
    start_at, end_at, all_day,
    color, category, entity_type, entity_id,
    recurrence_rule, recurrence_end,
    reminder_minutes,
  } = body;

  if (!title || !start_at) {
    return NextResponse.json({ error: 'title e start_at são obrigatórios' }, { status: 400 });
  }

  const { data: event, error } = await supabase
    .schema('jarvis')
    .from('events')
    .insert({
      user_id: userId,
      title, description, location,
      start_at, end_at,
      all_day: all_day ?? false,
      color,
      category:        category ?? 'personal',
      entity_type:     entity_type ?? null,
      entity_id:       entity_id ?? null,
      recurrence_rule: recurrence_rule ?? null,
      recurrence_end:  recurrence_end ?? null,
      reminder_minutes: reminder_minutes ?? null,
      source: 'lev',
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Agenda lembretes no QStash se houver
  if (reminder_minutes?.length) {
    await scheduleRemindersForEvent(
      event.id, String(userId), authUserId, title
    );
  }

  return NextResponse.json({ event }, { status: 201 });
}