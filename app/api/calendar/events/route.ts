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

// ── GET: BUSCAR EVENTOS (MEUS + PARTILHADOS COMIGO) ──────────────────────────
export async function GET(req: NextRequest) {
  const authUserId = await getAuthUUID(req);
  if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    // PASSO 1: Obter o ID Numérico (BigInt) do utilizador atual.
    const { data: userProfile } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    const myBigIntId = userProfile?.id;
    
    if (!myBigIntId) {
      return NextResponse.json({ error: 'Perfil de utilizador não encontrado' }, { status: 404 });
    }

    // PASSO 2: Buscar IDs dos eventos EXPLICITAMENTE partilhados comigo
    let sharedEventIds: string[] = [];
    const { data: shared } = await supabase
      .schema('jarvis')
      .from('event_shares')
      .select('event_id')
      .eq('shared_with_id', myBigIntId)
      .eq('active', true);
      
    if (shared && shared.length > 0) {
      sharedEventIds = shared.map(s => s.event_id);
    }

    // PASSO 3: Montar a query segura na tabela 'events'
    let query = supabase.schema('jarvis').from('events').select('*');

    if (sharedEventIds.length > 0) {
      // CORREÇÃO: Usar myBigIntId em vez de authUserId para casar com a coluna BIGINT
      const idsString = sharedEventIds.map(id => `'${id}'`).join(',');
      query = query.or(`user_id.eq.${myBigIntId},id.in.(${idsString})`);
    } else {
      // CORREÇÃO: Usar myBigIntId em vez de authUserId
      query = query.eq('user_id', myBigIntId);
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

    // Obter o ID numérico do criador para guardar na tabela events
    const { data: userProfile } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    if (!userProfile) {
        return NextResponse.json({ error: 'Perfil de utilizador não encontrado' }, { status: 404 });
    }

    const { data, error } = await supabase
      .schema('jarvis')
      .from('events') // <-- Corrigido para a tabela correta
      .insert({
        user_id: userProfile.id, // A tabela events espera o ID numérico (bigint)
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

// ── PUT: ATUALIZAR EVENTO ────────────────────────────────────────────────────
export async function PUT(req: NextRequest) {
    // Extraímos o ID da rota, assumindo que a chamada seja /api/calendar/events/[id]
    // Como Next.js app router trata rotas dinâmicas noutro ficheiro, se o PUT estiver na rota raiz, 
    // ele deve extrair o ID do corpo da requisição.
    const authUserId = await getAuthUUID(req);
    if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    try {
        const body = await req.json();
        const { id, ...updateData } = body;

        if (!id) return NextResponse.json({ error: 'ID do evento obrigatório' }, { status: 400 });

        // Validação de segurança: apenas o dono pode editar
        const { data: userProfile } = await supabase
            .schema('jarvis')
            .from('users')
            .select('id')
            .eq('auth_user_id', authUserId)
            .single();

        const { data: event } = await supabase
            .schema('jarvis')
            .from('events')
            .select('user_id')
            .eq('id', id)
            .single();

        if (!event || event.user_id !== userProfile?.id) {
            return NextResponse.json({ error: 'Sem permissão para editar' }, { status: 403 });
        }

        const { data, error } = await supabase
            .schema('jarvis')
            .from('events')
            .update(updateData)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        return NextResponse.json({ ok: true, event: data });

    } catch (e: any) {
        console.error('[Calendar PUT Error]', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

// ── DELETE: APAGAR EVENTO ────────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
    const authUserId = await getAuthUUID(req);
    if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    try {
        const { searchParams } = new URL(req.url);
        const id = searchParams.get('id');

        if (!id) return NextResponse.json({ error: 'ID do evento obrigatório' }, { status: 400 });

        // Validação de segurança: apenas o dono pode apagar
        const { data: userProfile } = await supabase
            .schema('jarvis')
            .from('users')
            .select('id')
            .eq('auth_user_id', authUserId)
            .single();

        const { data: event } = await supabase
            .schema('jarvis')
            .from('events')
            .select('user_id')
            .eq('id', id)
            .single();

        if (!event || event.user_id !== userProfile?.id) {
            return NextResponse.json({ error: 'Sem permissão para apagar' }, { status: 403 });
        }

        const { error } = await supabase
            .schema('jarvis')
            .from('events')
            .delete()
            .eq('id', id);

        if (error) throw error;
        return NextResponse.json({ ok: true });

    } catch (e: any) {
        console.error('[Calendar DELETE Error]', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}