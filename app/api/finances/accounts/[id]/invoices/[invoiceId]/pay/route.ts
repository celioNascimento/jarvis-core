// app/api/finances/accounts/[id]/invoices/[invoiceId]/pay/route.ts
// POST — registra pagamento de fatura

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { resolveUser } from '@/lib/finances/auth';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; invoiceId: string }> }
) {
  try {
    const { id, invoiceId } = await params;
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const body = await req.json().catch(() => ({}));

    // Busca a fatura
    const { data: invoice } = await supabase
      .from('credit_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('account_id', id)
      .eq('jarvis_user_id', user.jarvisUserId)
      .maybeSingle();

    if (!invoice) return NextResponse.json({ error: 'Fatura não encontrada' }, { status: 404 });
    if (invoice.status === 'paid') return NextResponse.json({ error: 'Fatura já paga' }, { status: 422 });

    const payAmount = body.amount ? Number(body.amount) : invoice.total_amount - invoice.paid_amount;

    // Atualiza fatura
    const { error: invError } = await supabase
      .from('credit_invoices')
      .update({
        paid_amount: invoice.paid_amount + payAmount,
        status:      invoice.paid_amount + payAmount >= invoice.total_amount ? 'paid' : invoice.status,
        paid_at:     new Date().toISOString(),
      })
      .eq('id', invoiceId);

    if (invError) throw invError;

    // Cria transação de despesa (pagamento da fatura)
    const today = new Date().toISOString().split('T')[0];

    // Busca categoria "Finanças/Dívidas > Parcelas"
    const { data: cat } = await supabase
      .from('categories')
      .select('id')
      .eq('name', 'Parcelas')
      .is('user_id', null)
      .maybeSingle();

    // Busca conta corrente vinculada ao cartão
    const { data: account } = await supabase
      .from('user_accounts')
      .select('linked_account_id')
      .eq('id', id)
      .maybeSingle();

    const refMonth = new Date(invoice.reference_month + 'T12:00:00')
      .toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    await supabase.from('transactions').insert({
      user_id:         user.authUserId,
      jarvis_user_id:  user.jarvisUserId,
      amount:          payAmount,
      type:            'expense',
      description:     `Pagamento fatura ${refMonth}`,
      transaction_date: today,
      category_id:     cat?.id || null,
      user_account_id: account?.linked_account_id || null,
      source:          'manual',
      status:          'confirmed',
      confidence:      1.0,
    });

    return NextResponse.json({ ok: true, paid_amount: payAmount });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}