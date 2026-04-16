// app/api/routines/checkin/route.ts
// POST: registra ou remove um checkin do dia

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getSupabase = () => createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

async function getUserId(req: NextRequest): Promise<number | null> {
  const supabase = getSupabase();
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  const { data } = await supabase
    .schema('jarvis')
    .from('users')
    .select('id')
    .eq('auth_user_id', user.id)
    .single();
  return data?.id ?? null;
}

// ── GET /api/routines/checkins?date=YYYY-MM-DD ────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const supabase = getSupabase();
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const date = searchParams.get('date') ?? new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .schema('jarvis')
      .from('routine_checkins')
      .select('routine_id, status, note')
      .eq('user_id', userId)
      .eq('date', date);

    if (error) throw error;
    return NextResponse.json({ checkins: data ?? [] });
  } catch (err: any) {
    console.error('[checkins GET]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ── POST /api/routines/checkin ────────────────────────────────────────────────
// status: 'done' | 'skipped' | null (null = remover)
export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabase();
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { routine_id, status, date, note } = body;

    if (!routine_id) {
      return NextResponse.json({ error: 'routine_id é obrigatório' }, { status: 400 });
    }

    const checkinDate = date ?? new Date().toISOString().split('T')[0];

    // null = toggle off (remover checkin do dia)
    if (status === null) {
      const { error } = await supabase
        .schema('jarvis')
        .from('routine_checkins')
        .delete()
        .eq('routine_id', routine_id)
        .eq('user_id', userId)
        .eq('date', checkinDate);
      if (error) throw error;
      return NextResponse.json({ removed: true });
    }

    const validStatuses = ['done', 'skipped'];
    if (!validStatuses.includes(status)) {
      return NextResponse.json({ error: 'status inválido' }, { status: 400 });
    }

    // Upsert por causa do constraint UNIQUE (routine_id, user_id, date)
    const { data, error } = await supabase
      .schema('jarvis')
      .from('routine_checkins')
      .upsert(
        { routine_id, user_id: userId, date: checkinDate, status, note: note ?? null },
        { onConflict: 'routine_id,user_id,date' },
      )
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ checkin: data });
  } catch (err: any) {
    console.error('[checkin POST]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
