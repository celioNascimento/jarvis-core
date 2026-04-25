// app/api/finances/investments/events/route.ts
// GET lista eventos, POST cria evento manual

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

    const { searchParams } = new URL(req.url);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const type  = searchParams.get('type');

    let query = supabase
      .from('investment_events')
      .select('*, investment_account:investment_accounts(broker_name,broker_color)')
      .eq('jarvis_user_id', user.jarvisUserId)
      .order('event_date', { ascending: false })
      .limit(limit);

    if (type) query = query.eq('event_type', type);

    const { data, error } = await query;
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
    const { event_type, gross_amount } = body;

    if (!event_type || !gross_amount)
      return NextResponse.json({ error: 'event_type e gross_amount obrigatórios' }, { status: 400 });

    // Busca primeira conta de investimento do usuário se não especificada
    let accountId = body.investment_account_id;
    if (!accountId) {
      const { data: acc } = await supabase
        .from('investment_accounts')
        .select('id')
        .eq('jarvis_user_id', user.jarvisUserId)
        .eq('is_active', true)
        .order('sort_order')
        .limit(1)
        .maybeSingle();
      accountId = acc?.id;
    }

    if (!accountId)
      return NextResponse.json({ error: 'Nenhuma carteira de investimento encontrada. Cadastre uma primeiro.' }, { status: 422 });

    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('investment_events')
      .insert({
        investment_account_id: accountId,
        user_id:               user.authUserId,
        jarvis_user_id:        user.jarvisUserId,
        event_type,
        ticker:                body.ticker || null,
        asset_name:            body.asset_name || body.ticker || null,
        gross_amount:          Number(gross_amount),
        ir_amount:             Number(body.ir_amount || 0),
        net_amount:            Number(body.net_amount ?? gross_amount),
        event_date:            body.event_date || today,
        source:                body.source || 'manual',
        source_id:             body.source_id || null,
        raw_notification:      body.raw_notification || null,
        notes:                 body.notes || null,
        auto_create_transaction: body.auto_create_transaction ?? true,
      })
      .select('*')
      .single();

    if (error) throw error;

    // Se for provento (dividendo/jcp/rendimento) e auto_create_transaction=true,
    // cria transação de receita na conta corrente principal
    if (
      data.auto_create_transaction &&
      ['dividendo', 'jcp', 'rendimento', 'amortizacao'].includes(event_type) &&
      data.net_amount > 0
    ) {
      try {
        // Busca categoria "Investimentos > Dividendos"
        const { data: cat } = await supabase
          .from('categories')
          .select('id')
          .or(`name.eq.Dividendos,name.eq.Rendimento CDB/LCI`)
          .is('user_id', null)
          .maybeSingle();

        // Busca conta corrente principal
        const { data: mainAccount } = await supabase
          .from('user_accounts')
          .select('id')
          .eq('jarvis_user_id', user.jarvisUserId)
          .eq('account_type', 'checking')
          .eq('is_active', true)
          .order('sort_order')
          .limit(1)
          .maybeSingle();

        const { data: tx } = await supabase
          .from('transactions')
          .insert({
            user_id:         user.authUserId,
            jarvis_user_id:  user.jarvisUserId,
            amount:          Number(data.net_amount),
            type:            'income',
            description:     `${EVENT_TYPE_LABELS[event_type]} ${data.ticker || data.asset_name || ''}`.trim(),
            transaction_date: data.event_date,
            category_id:     cat?.id || null,
            user_account_id: mainAccount?.id || null,
            source:          'manual',
            status:          'confirmed',
            confidence:      1.0,
          })
          .select('id')
          .single();

        if (tx) {
          // Vincula o evento à transação criada
          await supabase
            .from('investment_events')
            .update({ linked_transaction_id: tx.id })
            .eq('id', data.id);
        }
      } catch (txErr) {
        console.warn('[InvestmentEvent] Falha ao criar transação vinculada:', txErr);
      }
    }

    return NextResponse.json({ ok: true, data }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  dividendo: 'Dividendo', jcp: 'JCP', rendimento: 'Rendimento',
  amortizacao: 'Amortização', compra: 'Compra', venda: 'Venda', resgate: 'Resgate',
};
