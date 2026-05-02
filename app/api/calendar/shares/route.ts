// app/api/calendar/shares/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const category = searchParams.get('category');
  if (!category) return NextResponse.json({ error: 'category obrigatório' }, { status: 400 });

  const { data: userRow } = await supabase
    .from('users')
    .select('auth_user_id')
    .eq('id', userId)
    .maybeSingle();

  if (!userRow) return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });

  // Vínculos com agenda_enabled = true
  const { data: relationships } = await supabase
    .schema('jarvis')
    .from('relationships')
    .select('id, user_id_a, user_id_b, contact_name, settings')
    .eq('status', 'active')
    .or(`user_id_a.eq.${userRow.auth_user_id},user_id_b.eq.${userRow.auth_user_id}`);

  const agendaRelationships = (relationships ?? []).filter(
    r => r.settings?.agenda_enabled === true
  );

  if (agendaRelationships.length === 0) {
    return NextResponse.json({ ok: true, options: [] });
  }

  const partnerUUIDs = agendaRelationships.map(r =>
    r.user_id_a === userRow.auth_user_id ? r.user_id_b : r.user_id_a
  );

  const { data: partners } = await supabase
    .from('users')
    .select('id, auth_user_id, preferred_name, nickname, name')
    .in('auth_user_id', partnerUUIDs);

  const partnerBigintIds = (partners ?? []).map(p => p.id);

  // O que EU compartilhei
  const { data: existingShares } = await supabase
    .from('calendar_shares')
    .select('shared_with_id')
    .eq('owner_id', userId)
    .eq('category', category)
    .in('shared_with_id', partnerBigintIds);

  const activeShareIds = new Set((existingShares ?? []).map(s => s.shared_with_id));

  // O que o PARCEIRO compartilhou comigo
  const { data: receivedShares } = await supabase
    .from('calendar_shares')
    .select('owner_id, category')
    .eq('shared_with_id', userId)
    .eq('category', category)
    .in('owner_id', partnerBigintIds);

  const receivedShareKeys = new Set(
    (receivedShares ?? []).map(s => `${s.owner_id}:${s.category}`)
  );

  const options = agendaRelationships.map(rel => {
    const partnerUUID = rel.user_id_a === userRow.auth_user_id ? rel.user_id_b : rel.user_id_a;
    const partner = (partners ?? []).find(p => p.auth_user_id === partnerUUID);
    if (!partner) return null;

    return {
      user_id: partner.auth_user_id,
      bigint_id: partner.id,
      contact_name: partner.preferred_name || partner.nickname || partner.name || rel.contact_name || 'Contato',
      is_active: activeShareIds.has(partner.id),
      received_from_partner: receivedShareKeys.has(`${partner.id}:${category}`),
    };
  }).filter(Boolean);

  return NextResponse.json({ ok: true, options });
}

export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { category, shared_with_id, active } = await req.json();

  if (!category || !shared_with_id || typeof active !== 'boolean') {
    return NextResponse.json({ error: 'category, shared_with_id e active são obrigatórios' }, { status: 400 });
  }

  if (active) {
    const { error } = await supabase
      .from('calendar_shares')
      .upsert(
        { owner_id: userId, shared_with_id, category },
        { onConflict: 'owner_id,shared_with_id,category' }
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supabase
      .from('calendar_shares')
      .delete()
      .eq('owner_id', userId)
      .eq('shared_with_id', shared_with_id)
      .eq('category', category);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}