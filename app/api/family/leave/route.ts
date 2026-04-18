import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ============================================================
// /api/family/leave
//
// POST → sai da família atual
//        Se o usuário for o owner e houver outros membros,
//        bloqueia — owner deve transferir ou dissolver antes.
//        Se for o último membro, deleta a família também.
// ============================================================

function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

export async function POST(req: Request) {
  const token = extractToken(req);
  const authUserId = await getUserFromToken(token);
  if (!authUserId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    // Busca usuário
    const { data: user } = await supabase
      .from('users')
      .select('id, family_id')
      .eq('auth_user_id', String(authUserId))
      .maybeSingle();

    if (!user) {
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });
    }

    if (!user.family_id) {
      return NextResponse.json({ error: 'Você não pertence a nenhuma família' }, { status: 400 });
    }

    // Busca a família
    const { data: family } = await supabase
      .from('families')
      .select('id, owner_id')
      .eq('id', user.family_id)
      .single();

    if (!family) {
      // Família sumiu — limpa o vínculo mesmo assim
      await supabase.from('users').update({ family_id: null }).eq('id', user.id);
      return NextResponse.json({ ok: true });
    }

    // Conta outros membros
    const { count: memberCount } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', family.id);

    const isOwner        = family.owner_id === user.id;
    const otherMembers   = (memberCount ?? 0) - 1; // exclui o próprio usuário

    if (isOwner && otherMembers > 0) {
      return NextResponse.json(
        {
          error: 'Você é o dono da família. Transfira a propriedade ou remova os outros membros antes de sair.',
        },
        { status: 403 }
      );
    }

    // Desvincula o usuário
    const { error: updateError } = await supabase
      .from('users')
      .update({ family_id: null })
      .eq('id', user.id);

    if (updateError) throw updateError;

    // Se era o último membro, deleta a família
    if (otherMembers === 0) {
      await supabase.from('families').delete().eq('id', family.id);
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}