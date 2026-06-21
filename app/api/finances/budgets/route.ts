// app/api/finances/budgets/route.ts
// GET lista orçamentos, POST cria orçamento

import { NextRequest, NextResponse } from 'next/server';
import { getBudgetsWithUsage, createBudget } from '@/lib/finances/db';
import { resolveUser } from '@/lib/finances/auth';
import { supabase } from '@/lib/jarvis';




export async function GET(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const budgets = await getBudgetsWithUsage(user.jarvisUserId, user.authUserId);
    return NextResponse.json({ ok: true, data: budgets });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const body = await req.json();
    const { category_name, amount, period_start, period_end } = body;

    if (!category_name || !amount)
      return NextResponse.json({ error: 'category_name e amount obrigatórios' }, { status: 400 });

    const budget = await createBudget(
      user.authUserId,
      user.jarvisUserId,
      category_name,
      amount,
      period_start && period_end ? 'custom' : 'month',
      period_start && period_end ? { start: period_start, end: period_end } : undefined
    );

    return NextResponse.json({ ok: true, data: budget }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'ID obrigatório' }, { status: 400 });

    // Verifica propriedade
    const { data: budget } = await supabase
      .from('budgets')
      .select('jarvis_user_id')
      .eq('id', id)
      .maybeSingle();

    if (!budget || budget.jarvis_user_id !== user.jarvisUserId)
      return NextResponse.json({ error: 'Orçamento não encontrado' }, { status: 404 });

    const { error } = await supabase.from('budgets').delete().eq('id', id);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
