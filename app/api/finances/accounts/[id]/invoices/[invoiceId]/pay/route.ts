// app/api/finances/accounts/[id]/invoices/[invoiceId]/pay/route.ts
// POST — registra pagamento de fatura

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

async function resolveUser(req: NextRequest) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim();
  if (!token) return null;
  const { createClient: c } = await import('@supabase/supabase-js');
  const { data: { user } } = await c(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!).auth.getUser(token);
  if (!user) return null;
  const { data: j } = await supabase.from('users').select('id').eq('auth_user_id', user.id).maybeSingle();
  return j ? { authUserId: user.id, jarvisUserId: j.id as number } : null;
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string; invoiceId: string }> } // <-- Correção aqui
) {
  try {
    const params = await context.params; // <-- Await adicionado aqui

    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const body = await req.json().catch(() => ({}));

    // Busca a fatura
    const { data: invoice } = await supabase
      .from('credit_invoices')
      .select('*')
      .eq('id', params.invoiceId)
      .eq('account_id', params.id)
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
      .eq('id', params.invoiceId);

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
      .eq('id', params.id)
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