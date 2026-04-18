import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ============================================================
// /api/family
//
// GET    → retorna a família do usuário autenticado
// POST   → cria uma nova família (usuário vira owner)
// ============================================================

function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

// Resolve auth_user_id (UUID) → jarvis.users.id (bigint)
async function resolveNumericUserId(authUserId: string): Promise<number | null> {
  const { data } = await supabase
    .from('users')
    .select('id, family_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  return data?.id ?? null;
}

async function resolveUserRow(authUserId: string) {
  const { data } = await supabase
    .from('users')
    .select('id, family_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  return data ?? null;
}

// ── GET /api/family ──────────────────────────────────────────
// Retorna { family } ou { family: null } se não tiver família
export async function GET(req: Request) {
  const token = extractToken(req);
  const authUserId = await getUserFromToken(token);
  if (!authUserId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const user = await resolveUserRow(String(authUserId));
    if (!user) {
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });
    }

    if (!user.family_id) {
      return NextResponse.json({ ok: true, family: null });
    }

    const { data: family, error } = await supabase
      .from('families')
      .select('id, name, owner_id, plan, plan_started_at, plan_expires_at, created_at')
      .eq('id', user.family_id)
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, family });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── POST /api/family ─────────────────────────────────────────
// Body: { name: string }
// Cria família e vincula o usuário como owner
export async function POST(req: Request) {
  const token = extractToken(req);
  const authUserId = await getUserFromToken(token);
  if (!authUserId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const name = body?.name?.trim();

    if (!name) {
      return NextResponse.json({ error: 'name é obrigatório' }, { status: 400 });
    }

    const user = await resolveUserRow(String(authUserId));
    if (!user) {
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });
    }

    if (user.family_id) {
      return NextResponse.json(
        { error: 'Você já pertence a uma família. Saia dela antes de criar uma nova.' },
        { status: 409 }
      );
    }

    // Cria a família com o owner_id numérico
    const { data: family, error: createError } = await supabase
      .from('families')
      .insert({ name, owner_id: user.id, plan: 'free' })
      .select('id, name, owner_id, plan, plan_started_at, plan_expires_at, created_at')
      .single();

    if (createError) throw createError;

    // Vincula o usuário à família criada
    const { error: updateError } = await supabase
      .from('users')
      .update({ family_id: family.id })
      .eq('id', user.id);

    if (updateError) throw updateError;

    return NextResponse.json({ ok: true, family }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}