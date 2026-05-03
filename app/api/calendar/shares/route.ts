// app/api/calendar/shares/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const event_id = searchParams.get('event_id');
  if (!event_id) return NextResponse.json({ error: 'event_id ausente' }, { status: 400 });

  // 1. Busca o auth UUID do usuário logado
  const { data: userRow } = await supabase
    .from('users')
    .select('auth_user_id')
    .eq('id', userId)
    .maybeSingle();

  if (!userRow) return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });

  // 2. Vínculos com agenda_enabled = true (mesma chave do shares/route.ts)
  const { data: relationships } = await supabase
    .from('relationships')
    .select('user_id_a, user_id_b, contact_name, settings')
    .eq('status', 'active')
    .or(`user_id_a.eq.${userRow.auth_user_id},user_id_b.eq.${userRow.auth_user_id}`);

  const agendaRels = (relationships ?? []).filter(
    r => r.settings?.agenda_enabled === true
  );

  if (agendaRels.length === 0) {
    return NextResponse.json({ ok: true, options: [] });
  }

  // 3. Converte UUIDs dos parceiros para bigint_ids
  const partnerUUIDs = agendaRels.map(r =>
    r.user_id_a === userRow.auth_user_id ? r.user_id_b : r.user_id_a
  );

  const { data: partners } = await supabase
    .from('users')
    .select('id, auth_user_id, preferred_name, nickname, name')
    .in('auth_user_id', partnerUUIDs);

  // 4. Busca compartilhamentos ativos para ESTE evento
  const partnerBigintIds = (partners ?? []).map(p => p.id);

  const { data: shares } = await supabase
    .from('calendar_event_shares')
    .select('shared_with_id')
    .eq('event_id', event_id)
    .in('shared_with_id', partnerBigintIds);

  const activeIds = new Set((shares ?? []).map(s => String(s.shared_with_id)));

  // 5. Monta as opções
  const options = agendaRels.map(rel => {
    const partnerUUID = rel.user_id_a === userRow.auth_user_id ? rel.user_id_b : rel.user_id_a;
    const partner = (partners ?? []).find(p => p.auth_user_id === partnerUUID);
    if (!partner) return null;

    return {
      user_id: partner.auth_user_id,
      bigint_id: partner.id,
      contact_name: partner.preferred_name || partner.nickname || partner.name || rel.contact_name || 'Contato',
      is_active: activeIds.has(String(partner.id)),
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