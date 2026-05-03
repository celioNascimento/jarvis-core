import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ── HELPER DE AUTENTICAÇÃO ────────────────────────────────────────────────────
// Extrai o UUID do utilizador diretamente do cabeçalho de Autorização (JWT)
async function getAuthUUID(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

// ── GET: BUSCAR EVENTOS (MEUS + COMPARTILHADOS COMIGO) ───────────────────────
export async function GET(req: NextRequest) {
  const authUserId = await getAuthUUID(req);
  if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    // PASSO 1: Obter o ID Numérico (BigInt) do utilizador atual.
    // É essencial porque os compartilhamentos (event_shares) usam o ID numérico.
    const { data: userProfile } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    const myBigIntId = userProfile?.id;

    // PASSO 2: Buscar IDs dos eventos EXPLICITAMENTE partilhados comigo
    let sharedEventIds: string[] = [];
    if (myBigIntId) {
      const { data: shared } = await supabase
        .schema('jarvis')
        .from('event_shares')
        .select('event_id')
        .eq('shared_with_id', myBigIntId)
        .eq('active', true);
        
      if (shared && shared.length > 0) {
        sharedEventIds = shared.map(s => s.event_id);
      }
    }

    // PASSO 3: Montar a query segura (Meus eventos OU eventos na lista de permitidos)
    let query = supabase.schema('jarvis').from('calendar_events').select('*');

    if (sharedEventIds.length > 0) {
      const idsString = sharedEventIds.join(',');
      query = query.or(`user_id.eq.${authUserId},id.in.(${idsString})`);
    } else {
      query = query.eq('user_id', authUserId);
    }

    // Executa a query ordenada por data
    const { data: events, error } = await query.order('start_at', { ascending: true });
    
    if (error) throw error;

    return NextResponse.json({ ok: true, events });
  } catch (e: any) {
    console.error('[Calendar GET Error]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── POST: CRIAR NOVO EVENTO ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const authUserId = await getAuthUUID(req);
  if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const body = await req.json();

    const { data, error } = await supabase
      .schema('jarvis')
      .from('calendar_events')
      .insert({
        user_id: authUserId,
        title: body.title,
        description: body.description,
        location: body.location,
        start_at: body.start_at,
        end_at: body.end_at,
        all_day: body.all_day,
        category: body.category,
        reminder_minutes: body.reminder_minutes,
        source: 'lev'
      })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ ok: true, event: data });
  } catch (e: any) {
    console.error('[Calendar POST Error]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}