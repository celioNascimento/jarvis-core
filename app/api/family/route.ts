import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ============================================================
// /api/family
//
// GET  → retorna a família do usuário autenticado
// POST → cria uma nova família (usuário vira owner)
//
// NOTA: getUserFromToken() já retorna o id BIGINT de jarvis.users
// ============================================================

function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

// ── GET /api/family ──────────────────────────────────────────
export async function GET(req: Request) {
  const token = extractToken(req);
  const userId = await getUserFromToken(token); // já é o bigint numérico
  if (!userId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, family_id')
      .eq('id', userId)
      .maybeSingle();

    if (userError) throw userError;
    if (!user) {
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });
    }

    if (!user.family_id) {
      return NextResponse.json({ ok: true, family: null });
    }

    const { data: family, error: familyError } = await supabase
      .from('families')
      .select('id, name, owner_id, plan, plan_started_at, plan_expires_at, created_at')
      .eq('id', user.family_id)
      .single();

    if (familyError) throw familyError;

    return NextResponse.json({ ok: true, family });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── POST /api/family ─────────────────────────────────────────
// Body: { name: string }
export async function POST(req: Request) {
  const token = extractToken(req);
  const userId = await getUserFromToken(token); // já é o bigint numérico
  if (!userId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const name = body?.name?.trim();

    if (!name) {
      return NextResponse.json({ error: 'name é obrigatório' }, { status: 400 });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, family_id')
      .eq('id', userId)
      .maybeSingle();

    if (userError) throw userError;
    if (!user) {
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });
    }

    if (user.family_id) {
      return NextResponse.json(
        { error: 'Você já pertence a uma família. Saia dela antes de criar uma nova.' },
        { status: 409 }
      );
    }

    // owner_id é o id numérico direto — sem conversão
    const { data: family, error: createError } = await supabase
      .from('families')
      .insert({ name, owner_id: userId, plan: 'free' })
      .select('id, name, owner_id, plan, plan_started_at, plan_expires_at, created_at')
      .single();

    if (createError) throw createError;

    const { error: updateError } = await supabase
      .from('users')
      .update({ family_id: family.id })
      .eq('id', userId);

    if (updateError) throw updateError;

    return NextResponse.json({ ok: true, family }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}