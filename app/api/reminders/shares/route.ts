import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const reminder_id = searchParams.get('reminder_id');
  if (!reminder_id) return NextResponse.json({ error: 'reminder_id ausente' }, { status: 400 });

  // 1. Verifica que o lembrete pertence ao usuário logado
  const { data: reminder } = await supabase
    .schema('jarvis')
    .from('reminders')
    .select('user_id')
    .eq('id', reminder_id)
    .maybeSingle();

  if (!reminder || reminder.user_id !== userId) {
    return NextResponse.json({ error: 'Lembrete não encontrado' }, { status: 404 });
  }

  // 2. Busca o auth_user_id do dono
  const { data: userRow } = await supabase
    .schema('jarvis')
    .from('users')
    .select('auth_user_id')
    .eq('id', userId)
    .maybeSingle();

  if (!userRow) return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });

  // 3. Vínculos ativos com agenda_enabled (mesma lógica dos eventos)
  const { data: relationships } = await supabase
    .schema('jarvis')
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

  // 4. Resolve parceiros para bigint_id
  const partnerUUIDs = agendaRels.map(r =>
    r.user_id_a === userRow.auth_user_id ? r.user_id_b : r.user_id_a
  );

  const { data: partners } = await supabase
    .schema('jarvis')
    .from('users')
    .select('id, auth_user_id, preferred_name, nickname, name')
    .in('auth_user_id', partnerUUIDs);

  // 5. Shares ativos para ESTE lembrete
  const partnerBigintIds = (partners ?? []).map(p => p.id);

  const { data: shares } = await supabase
    .schema('jarvis')
    .from('reminder_shares')
    .select('shared_with_id')
    .eq('reminder_id', reminder_id)
    .eq('active', true)
    .in('shared_with_id', partnerBigintIds);

  const activeIds = new Set((shares ?? []).map(s => String(s.shared_with_id)));

  // 6. Monta opções no mesmo formato que o modal espera
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

  try {
    const { reminder_id, shared_with_id, active } = await req.json();

    if (!reminder_id || !shared_with_id || typeof active !== 'boolean') {
      return NextResponse.json(
        { error: 'reminder_id, shared_with_id e active são obrigatórios' },
        { status: 400 }
      );
    }

    // Confirma que o lembrete pertence ao usuário
    const { data: reminder } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select('user_id')
      .eq('id', reminder_id)
      .maybeSingle();

    if (!reminder || reminder.user_id !== userId) {
      return NextResponse.json({ error: 'Lembrete não encontrado' }, { status: 404 });
    }

    const { error } = await supabase
      .schema('jarvis')
      .from('reminder_shares')
      .upsert(
        {
          reminder_id,
          shared_with_id: Number(shared_with_id),
          active,
        },
        { onConflict: 'reminder_id,shared_with_id' }  // sem espaço
      );

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[Reminder Shares POST] Erro:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}