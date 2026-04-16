// app/api/routines/route.ts
// CRUD de rotinas — GET lista + POST nova rotina

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

async function getUserId(req: NextRequest): Promise<number | null> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  const { data } = await supabase
    .from('jarvis.users')
    .select('id')
    .eq('auth_user_id', user.id)
    .single();
  return data?.id ?? null;
}

// ── GET /api/routines ─────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await supabase
      .schema('jarvis')
      .from('routines')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) throw error;
    return NextResponse.json({ routines: data ?? [] });
  } catch (err: any) {
    console.error('[routines GET]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ── POST /api/routines ────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { anchor, action, period = 'anytime', goal_tag, linked_to_child } = body;

    if (!anchor?.trim() || !action?.trim()) {
      return NextResponse.json({ error: 'anchor e action são obrigatórios' }, { status: 400 });
    }

    const validPeriods = ['morning', 'afternoon', 'evening', 'anytime'];
    if (!validPeriods.includes(period)) {
      return NextResponse.json({ error: 'period inválido' }, { status: 400 });
    }

    // Sort order = max atual + 1
    const { data: existing } = await supabase
      .schema('jarvis')
      .from('routines')
      .select('sort_order')
      .eq('user_id', userId)
      .order('sort_order', { ascending: false })
      .limit(1);

    const nextOrder = (existing?.[0]?.sort_order ?? 0) + 1;

    const { data, error } = await supabase
      .schema('jarvis')
      .from('routines')
      .insert({
        user_id: userId,
        anchor: anchor.trim(),
        action: action.trim(),
        period,
        goal_tag: goal_tag?.trim() || null,
        linked_to_child: linked_to_child ?? null,
        sort_order: nextOrder,
      })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ routine: data }, { status: 201 });
  } catch (err: any) {
    console.error('[routines POST]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
