import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ============================================================
// /api/family/leave
// POST → sai da família atual
// NOTA: getUserFromToken() já retorna o id BIGINT de jarvis.users
// ============================================================

function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

export async function POST(req: Request) {
  const token = extractToken(req);
  const userId = await getUserFromToken(token);
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
      return NextResponse.json({ error: 'Você não pertence a nenhuma família' }, { status: 400 });
    }

    const { data: family } = await supabase
      .from('families')
      .select('id, owner_id')
      .eq('id', user.family_id)
      .single();

    if (!family) {
      // Família sumiu — limpa o vínculo mesmo assim
      await supabase.from('users').update({ family_id: null }).eq('id', userId);
      return NextResponse.json({ ok: true });
    }

    // Conta outros membros (além do próprio usuário)
    const { count: memberCount } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', family.id);

    const isOwner      = family.owner_id === userId;
    const otherMembers = (memberCount ?? 0) - 1;

    if (isOwner && otherMembers > 0) {
      return NextResponse.json(
        { error: 'Você é o dono da família. Transfira a propriedade ou remova os outros membros antes de sair.' },
        { status: 403 }
      );
    }

    const { error: updateError } = await supabase
      .from('users')
      .update({ family_id: null })
      .eq('id', userId);

    if (updateError) throw updateError;

    // Último membro saindo — deleta a família
    if (otherMembers === 0) {
      await supabase.from('families').delete().eq('id', family.id);
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}