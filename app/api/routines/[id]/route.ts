// app/api/routines/[id]/route.ts
// DELETE: desativa (soft delete via is_active = false) uma rotina

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

async function getUserId(req: NextRequest): Promise<number | null> {
  const auth  = req.headers.get('authorization') ?? '';
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

// ── DELETE /api/routines/[id] ─────────────────────────────────────────────────
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;

    // Soft delete — mantém histórico de checkins
    const { error } = await supabase
      .schema('jarvis')
      .from('routines')
      .update({ is_active: false })
      .eq('id', id)
      .eq('user_id', userId); // segurança: só o dono pode deletar

    if (error) throw error;
    return NextResponse.json({ deleted: true });
  } catch (err: any) {
    console.error('[routines DELETE]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ── PATCH /api/routines/[id] ──────────────────────────────────────────────────
// Para editar campos: anchor, action, period, goal_tag, sort_order, is_active
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const body = await req.json();

    const allowed = ['anchor', 'action', 'period', 'goal_tag', 'sort_order', 'is_active'];
    const updates: Record<string, any> = {};
    for (const key of allowed) {
      if (key in body) updates[key] = body[key];
    }

    if (!Object.keys(updates).length) {
      return NextResponse.json({ error: 'Nenhum campo para atualizar' }, { status: 400 });
    }

    const { data, error } = await supabase
      .schema('jarvis')
      .from('routines')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ routine: data });
  } catch (err: any) {
    console.error('[routines PATCH]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
