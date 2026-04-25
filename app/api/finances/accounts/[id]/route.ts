// app/api/finances/accounts/[id]/route.ts
// GET detalhe de uma conta específica

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

    const { data, error } = await supabase
      .from('user_accounts')
      .select('*')
      .eq('id', params.id)
      .eq('jarvis_user_id', user.jarvisUserId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'Conta não encontrada' }, { status: 404 });

    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const body = await req.json();

    // Só permite atualizar campos seguros
    const allowed = [
      'account_label', 'account_last_digits', 'current_balance',
      'credit_limit', 'closing_day', 'due_day', 'color',
      'sort_order', 'is_active', 'notes', 'linked_account_id',
    ];
    const update: Record<string, any> = {};
    for (const key of allowed) {
      if (key in body) update[key] = body[key];
    }

    const { data, error } = await supabase
      .from('user_accounts')
      .update(update)
      .eq('id', params.id)
      .eq('jarvis_user_id', user.jarvisUserId)
      .select('*')
      .single();

    if (error) throw error;
    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    // Soft delete
    const { error } = await supabase
      .from('user_accounts')
      .update({ is_active: false })
      .eq('id', params.id)
      .eq('jarvis_user_id', user.jarvisUserId);

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
