import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userIdStr = await getUserFromToken(token); // Retorna BigInt em string
  if (!userIdStr) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const event_id = searchParams.get('event_id');

  if (!event_id) return NextResponse.json({ error: 'event_id ausente' }, { status: 400 });

  // 1. Busca os parceiros com calendário ativo (Chave Mestra)
  const { data: rels } = await supabase
    .from('relationships')
    .select('user_id_a, user_id_b, contact_name, settings')
    .eq('status', 'active');

  const eligibleRels = (rels || []).filter(r => r.settings?.calendar_enabled);

  // 2. Busca o ID do usuário autenticado para cruzamento
  const { data: { user } } = await supabase.auth.getUser(token);
  const authUuid = user?.id;

  // 3. Busca permissões ativas para ESTE evento
  const { data: shares } = await supabase
    .from('calendar_event_shares')
    .select('shared_with_id')
    .eq('event_id', event_id);

  const activeIds = new Set((shares || []).map(s => String(s.shared_with_id)));

  // 4. Monta as opções cruzando Auth UUID -> BigInt ID da tabela users
  const options = await Promise.all(eligibleRels.map(async (r) => {
    const partnerAuthUuid = r.user_id_a === authUuid ? r.user_id_b : r.user_id_a;
    
    // Converte o UUID do parceiro pro BigInt necessário no banco
    const { data: partnerUser } = await supabase
      .from('users')
      .select('id')
      .eq('auth_user_id', partnerAuthUuid)
      .single();

    if (!partnerUser) return null;

    return {
      user_id: partnerAuthUuid,
      bigint_id: partnerUser.id,
      contact_name: r.contact_name || 'Contato',
      is_active: activeIds.has(String(partnerUser.id))
    };
  }));

  return NextResponse.json({ ok: true, options: options.filter(Boolean) });
}

export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userIdStr = await getUserFromToken(token);
  if (!userIdStr) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { event_id, shared_with_id, active } = await req.json();

  if (active) {
    // Liga a permissão
    const { error } = await supabase
      .from('calendar_event_shares')
      .insert({ event_id, shared_with_id });
      
    if (error && error.code !== '23505') return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    // Desliga a permissão
    const { error } = await supabase
      .from('calendar_event_shares')
      .delete()
      .eq('event_id', event_id)
      .eq('shared_with_id', shared_with_id);
      
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}