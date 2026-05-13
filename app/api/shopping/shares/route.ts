// app/api/shopping/shares/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';
import { getActivePartnersBySetting } from '@/lib/modules/relationships';

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    const userId = await getUserFromToken(token); // ID numérico
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const category = searchParams.get('category');
    if (!category) return NextResponse.json({ error: 'category obrigatório' }, { status: 400 });

    // 1. Resolve UUID do usuário
    const { data: user } = await supabase.from('users').select('auth_user_id').eq('id', userId).single();
    
    // 2. Busca parceiros via Módulo de Permissões
    const partners = await getActivePartnersBySetting(user!.auth_user_id, 'shopping_enabled');
    if (partners.length === 0) return NextResponse.json({ ok: true, options: [] });

    const partnerIds = partners.map(p => p.bigint_id);

    // 3. Busca o que eu compartilho e o que recebo
    const { data: outgoing } = await supabase.from('shopping_shares').select('shared_with_id').eq('owner_id', userId).eq('category', category).in('shared_with_id', partnerIds);
    const { data: incoming } = await supabase.from('shopping_shares').select('owner_id').eq('shared_with_id', userId).eq('category', category).in('owner_id', partnerIds);

    const activeOutgoing = new Set(outgoing?.map(s => s.shared_with_id));
    const activeIncoming = new Set(incoming?.map(s => s.owner_id));

    // 4. Monta as opções
    const options = partners.map(p => ({
      user_id: p.auth_uuid,
      bigint_id: p.bigint_id,
      contact_name: p.contact_name,
      is_active: activeOutgoing.has(p.bigint_id),
      received_from_partner: activeIncoming.has(p.bigint_id),
    }));

    return NextResponse.json({ ok: true, options });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { category, shared_with_id, active } = await req.json();

  if (active) {
    await supabase.from('shopping_shares').upsert({ owner_id: userId, shared_with_id, category }, { onConflict: 'owner_id,shared_with_id,category' });
  } else {
    await supabase.from('shopping_shares').delete().eq('owner_id', userId).eq('shared_with_id', shared_with_id).eq('category', category);
  }

  return NextResponse.json({ ok: true });
}