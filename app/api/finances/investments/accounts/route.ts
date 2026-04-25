// app/api/finances/investments/accounts/route.ts
// GET lista carteiras, POST cria carteira de investimento

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
      .from('investment_accounts')
      .select('*')
      .eq('jarvis_user_id', user.jarvisUserId)
      .eq('is_active', true)
      .order('sort_order');

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
    if (!body.broker_name)
      return NextResponse.json({ error: 'broker_name obrigatório' }, { status: 400 });

    const { count } = await supabase
      .from('investment_accounts')
      .select('*', { count: 'exact', head: true })
      .eq('jarvis_user_id', user.jarvisUserId);

    const { data, error } = await supabase
      .from('investment_accounts')
      .insert({
        user_id:        user.authUserId,
        jarvis_user_id: user.jarvisUserId,
        broker_name:    body.broker_name,
        broker_code:    body.broker_code  || null,
        broker_color:   body.broker_color || null,
        broker_domain:  body.broker_domain|| null,
        account_label:  body.account_label|| null,
        account_number: body.account_number || null,
        is_active:      true,
        sort_order:     count ?? 0,
      })
      .select('*')
      .single();

    if (error) throw error;
    return NextResponse.json({ ok: true, data }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
