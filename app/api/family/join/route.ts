import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ============================================================
// /api/family/join
//
// POST → entra em uma família usando o ID (UUID) como código
// ============================================================

function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

// ── POST /api/family/join ────────────────────────────────────
// Body: { inviteCode: string }  — o inviteCode é o UUID da família
export async function POST(req: Request) {
  const token = extractToken(req);
  const authUserId = await getUserFromToken(token);
  if (!authUserId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const inviteCode = body?.inviteCode?.trim();

    if (!inviteCode) {
      return NextResponse.json({ error: 'inviteCode é obrigatório' }, { status: 400 });
    }

    // Busca usuário
    const { data: user } = await supabase
      .from('users')
      .select('id, family_id')
      .eq('auth_user_id', String(authUserId))
      .maybeSingle();

    if (!user) {
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });
    }

    if (user.family_id) {
      return NextResponse.json(
        { error: 'Você já pertence a uma família. Saia dela antes de entrar em outra.' },
        { status: 409 }
      );
    }

    // Valida se a família existe com esse UUID
    const { data: family, error: familyError } = await supabase
      .from('families')
      .select('id, name, plan')
      .eq('id', inviteCode)
      .maybeSingle();

    if (familyError || !family) {
      return NextResponse.json({ error: 'Código de convite inválido ou expirado' }, { status: 404 });
    }

    // Verifica limite de membros pelo plano
    const { count } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', family.id);

    const limits: Record<string, number> = {
      free: 2,
      personal: 1,
      family: 6,
      family_plus: 12,
    };
    const maxMembers = limits[family.plan] ?? 2;

    if ((count ?? 0) >= maxMembers) {
      return NextResponse.json(
        { error: `Família atingiu o limite de ${maxMembers} membros no plano ${family.plan}.` },
        { status: 403 }
      );
    }

    // Vincula o usuário à família
    const { error: updateError } = await supabase
      .from('users')
      .update({ family_id: family.id })
      .eq('id', user.id);

    if (updateError) throw updateError;

    return NextResponse.json({ ok: true, family });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}