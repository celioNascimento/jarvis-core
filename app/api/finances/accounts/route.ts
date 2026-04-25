// app/api/finances/accounts/route.ts — V2
// Usa lib/finances/auth.ts para resolver usuário

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resolveUser } from '@/lib/finances/auth';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

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

    const { count } = await supabase
      .from('user_accounts')
      .select('*', { count: 'exact', head: true })
      .eq('jarvis_user_id', user.jarvisUserId);

    const { data, error } = await supabase
      .from('user_accounts')
      .insert({
        user_id:             user.authUserId,
        jarvis_user_id:      user.jarvisUserId,
        bank_name,
        bank_code:           body.bank_code           || null,
        bank_color:          body.bank_color          || null,
        bank_domain:         body.bank_domain         || null,
        account_label:       body.account_label       || null,
        account_last_digits: body.account_last_digits || null,
        account_type,
        current_balance:     body.current_balance     ?? 0,
        credit_limit:        body.credit_limit        || null,
        closing_day:         body.closing_day         || null,
        due_day:             body.due_day             || null,
        linked_account_id:   body.linked_account_id   || null,
        is_active:           true,
        sort_order:          count ?? 0,
      })
      .select('*')
      .single();

    if (error) throw error;

    // Cria fatura inicial para cartão de crédito
    if (account_type === 'credit_card' && body.closing_day && body.due_day) {
      const now    = new Date();
      const year   = now.getFullYear();
      const month  = now.getMonth() + 1;
      const pad    = (n: number) => String(n).padStart(2, '0');

      const closing  = new Date(year, month - 1, body.closing_day);
      const due      = new Date(year, month - 1, body.due_day);
      if (body.due_day < body.closing_day) due.setMonth(due.getMonth() + 1);

      await supabase.from('credit_invoices').insert({
        account_id:      data.id,
        user_id:         user.authUserId,
        jarvis_user_id:  user.jarvisUserId,
        reference_month: `${year}-${pad(month)}-01`,
        closing_date:    closing.toISOString().split('T')[0],
        due_date:        due.toISOString().split('T')[0],
        total_amount:    0,
        status:          'open',
      });
    }

    return NextResponse.json({ ok: true, data }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
