// app/api/finances/accounts/route.ts
// GET lista contas, POST cria conta

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

export async function GET(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { data, error } = await supabase
      .from('user_accounts')
      .select('*')
      .eq('jarvis_user_id', user.jarvisUserId)
      .eq('is_active', true)
      .order('sort_order')
      .order('bank_name');

    if (error) throw error;
    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const body = await req.json();
    const { bank_name, account_type } = body;
    if (!bank_name || !account_type)
      return NextResponse.json({ error: 'bank_name e account_type obrigatórios' }, { status: 400 });

    // Sort order = total de contas + 1
    const { count } = await supabase
      .from('user_accounts')
      .select('*', { count: 'exact', head: true })
      .eq('jarvis_user_id', user.jarvisUserId);

    const { data, error } = await supabase
      .from('user_accounts')
      .insert({
        user_id:             user.authUserId,
        jarvis_user_id:      user.jarvisUserId,
        bank_name:           body.bank_name,
        bank_code:           body.bank_code || null,
        bank_color:          body.bank_color || null,
        bank_domain:         body.bank_domain || null,
        account_label:       body.account_label || null,
        account_last_digits: body.account_last_digits || null,
        account_type:        body.account_type,
        current_balance:     body.current_balance ?? 0,
        credit_limit:        body.credit_limit || null,
        closing_day:         body.closing_day || null,
        due_day:             body.due_day || null,
        linked_account_id:   body.linked_account_id || null,
        is_active:           true,
        sort_order:          count ?? 0,
      })
      .select('*')
      .single();

    if (error) throw error;

    // Se cartão de crédito, criar fatura do mês atual
    if (account_type === 'credit_card' && body.closing_day && body.due_day) {
      await createCurrentInvoice(data.id, user.authUserId, user.jarvisUserId, body.closing_day, body.due_day);
    }

    return NextResponse.json({ ok: true, data }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

async function createCurrentInvoice(
  accountId: string, authUserId: string, jarvisUserId: number,
  closingDay: number, dueDay: number
) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const closing = new Date(year, month - 1, closingDay);
  const due = new Date(year, month - 1, dueDay);

  // Se dueDay < closingDay, a fatura vence no mês seguinte
  if (dueDay < closingDay) due.setMonth(due.getMonth() + 1);

  const refMonth = new Date(year, month - 1, 1);

  await supabase.from('credit_invoices').insert({
    account_id:      accountId,
    user_id:         authUserId,
    jarvis_user_id:  jarvisUserId,
    reference_month: refMonth.toISOString().split('T')[0],
    closing_date:    closing.toISOString().split('T')[0],
    due_date:        due.toISOString().split('T')[0],
    total_amount:    0,
    status:          'open',
  }).select().single();
}