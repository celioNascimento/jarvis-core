import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';
import { invalidateContextField } from '@/lib/services/context-cache'; // [IMPORTANTE]

export async function POST(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
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
    if (!user || !user.family_id) {
      return NextResponse.json({ error: 'Usuário não encontrado ou sem família' }, { status: 404 });
    }

    const familyId = user.family_id;

    // Verifica se é owner antes de prosseguir
    const { data: family } = await supabase
      .from('families')
      .select('owner_id')
      .eq('id', familyId)
      .single();

    if (family) {
      const { count: memberCount } = await supabase
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', familyId);

      if (family.owner_id === userId && (memberCount ?? 0) > 1) {
        return NextResponse.json(
          { error: 'Transfira a propriedade antes de sair.' },
          { status: 403 }
        );
      }
    }

    // Executa a saída
    const { error: updateError } = await supabase
      .from('users')
      .update({ family_id: null })
      .eq('id', userId);

    if (updateError) throw updateError;

    // [RIGOR] REGRA 2: Invalidação de Cache
    // Invalida 'settings' ou 'familia' (dependendo de onde você guarda esse dado no RPC)
    await invalidateContextField(Number(userId), 'settings').catch(console.error);

    // Se era o último, deleta
    const { count: remaining } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', familyId);

    if (remaining === 0) {
      await supabase.from('families').delete().eq('id', familyId);
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
