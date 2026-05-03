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

  const { data: userRow } = await supabase
    .from('users')
    .select('auth_user_id')
    .eq('id', userId)
    .maybeSingle();

  if (!userRow) return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });

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

  const partnerUUIDs = agendaRels.map(r =>
    r.user_id_a === userRow.auth_user_id ? r.user_id_b : r.user_id_a
  );

  const { data: partners } = await supabase
    .from('users')
    .select('id, auth_user_id, preferred_name, nickname, name')
    .in('auth_user_id', partnerUUIDs);

  const partnerBigintIds = (partners ?? []).map(p => p.id);

  const { data: shares } = await supabase
    .from('calendar_event_shares')
    .select('shared_with_id')
    .eq('event_id', event_id)
    .in('shared_with_id', partnerBigintIds);

  const activeIds = new Set((shares ?? []).map(s => String(s.shared_with_id)));

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
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { event_id, shared_with_id, active } = await req.json();

  if (!event_id || !shared_with_id || typeof active !== 'boolean') {
    return NextResponse.json({ error: 'event_id, shared_with_id e active são obrigatórios' }, { status: 400 });
  }

  if (active) {
    const { error } = await supabase
      .from('calendar_event_shares')
      .upsert(
        { event_id, shared_with_id },
        { onConflict: 'event_id,shared_with_id' }
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supabase
      .from('calendar_event_shares')
      .delete()
      .eq('event_id', event_id)
      .eq('shared_with_id', shared_with_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}