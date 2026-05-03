import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ── GET /api/calendar/event-shares?event_id=xxx ───────────────────────────────
export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const eventId = searchParams.get('event_id');
  if (!eventId) return NextResponse.json({ error: 'event_id obrigatório' }, { status: 400 });

  // 1. Verifica se o evento pertence ao usuário
  const { data: event } = await supabase
    .schema('jarvis')
    .from('events')
    .select('id, user_id')
    .eq('id', eventId)
    .maybeSingle();

  if (!event) return NextResponse.json({ error: 'Evento não encontrado' }, { status: 404 });
  if (String(event.user_id) !== String(userId)) {
    return NextResponse.json({ error: 'Sem permissão' }, { status: 403 });
  }

  // 2. Busca compartilhamentos na tabela correta (sem procurar por 'active')
  const { data: shares } = await supabase
    .schema('jarvis')
    .from('calendar_event_shares')
    .select('shared_with_id')
    .eq('event_id', eventId);

  if (!shares || shares.length === 0) {
    return NextResponse.json({ ok: true, shared_with: [] });
  }

  const sharedIds = shares.map(s => s.shared_with_id);

  // 3. Resolve os nomes dos contatos
  const { data: users } = await supabase
    .schema('jarvis')
    .from('users')
    .select('id, auth_user_id, preferred_name, nickname, name')
    .in('id', sharedIds);

  const shared_with = (users ?? []).map(u => ({
    bigint_id:    u.id,
    user_id:      u.auth_user_id,
    contact_name: u.preferred_name || u.nickname || u.name || 'Contato',
  }));

  return NextResponse.json({ ok: true, shared_with });
}

// ── POST /api/calendar/event-shares ──────────────────────────────────────────
export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { event_id, shared_with_id, active } = await req.json();

  if (!event_id || !shared_with_id || typeof active !== 'boolean') {
    return NextResponse.json({ error: 'Dados obrigatórios faltando' }, { status: 400 });
  }

  // 1. Verifica dono
  const { data: event } = await supabase
    .schema('jarvis')
    .from('events')
    .select('id, user_id')
    .eq('id', event_id)
    .maybeSingle();

  if (!event) return NextResponse.json({ error: 'Evento não encontrado' }, { status: 404 });
  if (String(event.user_id) !== String(userId)) {
    return NextResponse.json({ error: 'Sem permissão' }, { status: 403 });
  }

  // 2. Salva a permissão na tabela correta, removendo a referência à coluna 'active'
  if (active) {
    const { error } = await supabase
      .schema('jarvis')
      .from('calendar_event_shares')
      .upsert(
        { event_id, shared_with_id }, // <-- APENAS OS IDs AQUI
        { onConflict: 'event_id,shared_with_id' }
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    // Se active for false, apagamos o registro
    const { error } = await supabase
      .schema('jarvis')
      .from('calendar_event_shares')
      .delete()
      .eq('event_id', event_id)
      .eq('shared_with_id', shared_with_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}