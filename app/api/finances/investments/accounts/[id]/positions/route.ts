// app/api/finances/investments/accounts/[id]/positions/route.ts
// GET posições da carteira, POST nova posição

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resolveUser } from '@/lib/finances/auth';


const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);


export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    // Verifica que a conta pertence ao usuário
    const { data: acc } = await supabase
      .from('investment_accounts')
      .select('id')
      .eq('id', params.id)
      .eq('jarvis_user_id', user.jarvisUserId)
      .maybeSingle();

    if (!acc) return NextResponse.json({ error: 'Carteira não encontrada' }, { status: 404 });

    const { searchParams } = new URL(req.url);
    const activeOnly = searchParams.get('active') !== 'false';

    let query = supabase
      .from('investment_positions')
      .select('*')
      .eq('investment_account_id', params.id)
      .order('asset_type')
      .order('asset_name');

    if (activeOnly) query = query.eq('is_active', true);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    // Verifica propriedade
    const { data: acc } = await supabase
      .from('investment_accounts')
      .select('id')
      .eq('id', params.id)
      .eq('jarvis_user_id', user.jarvisUserId)
      .maybeSingle();

    if (!acc) return NextResponse.json({ error: 'Carteira não encontrada' }, { status: 404 });

    const body = await req.json();
    if (!body.asset_name || !body.asset_type)
      return NextResponse.json({ error: 'asset_name e asset_type obrigatórios' }, { status: 400 });

    const { data, error } = await supabase
      .from('investment_positions')
      .insert({
        investment_account_id: params.id,
        user_id:               user.authUserId,
        jarvis_user_id:        user.jarvisUserId,
        ticker:                body.ticker         || null,
        asset_name:            body.asset_name,
        asset_type:            body.asset_type,
        quantity:              Number(body.quantity  || 0),
        avg_price:             Number(body.avg_price || 0),
        current_price:         body.current_price != null ? Number(body.current_price) : null,
        invested_amount:       body.invested_amount != null ? Number(body.invested_amount) : null,
        maturity_date:         body.maturity_date  || null,
        rate_type:             body.rate_type      || null,
        rate_value:            body.rate_value != null ? Number(body.rate_value) : null,
        fund_cnpj:             body.fund_cnpj      || null,
        notes:                 body.notes          || null,
        is_active:             true,
      })
      .select('*')
      .single();

    if (error) throw error;
    return NextResponse.json({ ok: true, data }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
