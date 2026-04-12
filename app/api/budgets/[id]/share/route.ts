import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const requesterNumericId = await getUserFromToken(token);
  if (!requesterNumericId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { targetEmail } = await req.json();
  if (!targetEmail) {
    return NextResponse.json({ error: 'targetEmail obrigatorio' }, { status: 400 });
  }

  const { data: budget, error: budgetErr } = await supabase
    .from('budgets')
    .select('user_id, shared_with')
    .eq('id', id)
    .single();
  if (budgetErr || !budget) {
    return NextResponse.json({ error: 'Budget nao encontrado' }, { status: 404 });
  }
  if (budget.user_id !== requesterNumericId) {
    return NextResponse.json({ error: 'Apenas o dono pode compartilhar' }, { status: 403 });
  }

  const { data: target } = await supabase
    .from('users')
    .select('auth_user_id')
    .eq('email', targetEmail)
    .single();
  if (!target?.auth_user_id) {
    return NextResponse.json({ error: 'Destinatario nao encontrado' }, { status: 404 });
  }

  const { data: rel } = await supabase
    .from('relationships')
    .select('status')
    .or(
      `and(user_id_a.eq.${target.auth_user_id},user_id_b.eq.${budget.user_id}),` +
      `and(user_id_a.eq.${budget.user_id},user_id_b.eq.${target.auth_user_id})`
    )
    .eq('status', 'active')
    .maybeSingle();
  if (!rel) {
    return NextResponse.json({ error: 'Relacao ativa nao encontrada' }, { status: 403 });
  }

  const newShared = [...(budget.shared_with || []), target.auth_user_id];
  const { error: updateErr } = await supabase
    .from('budgets')
    .update({ shared_with: newShared })
    .eq('id', id);

  if (updateErr) {
    return NextResponse.json({ error: 'Erro ao compartilhar' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}