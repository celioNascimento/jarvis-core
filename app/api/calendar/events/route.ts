import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ── HELPER DE AUTENTICAÇÃO ────────────────────────────────────────────────────
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
    const { data: userProfile } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    if (!userProfile) {
      return NextResponse.json({ error: 'Perfil de utilizador não encontrado' }, { status: 404 });
    }

    const myBigIntId = userProfile.id;

    // Eventos explicitamente partilhados comigo por evento específico
    const { data: eventShares } = await supabase
      .schema('jarvis')
      .from('calendar_event_shares')
      .select('event_id')
      .eq('shared_with_id', myBigIntId);

    const sharedEventIds: string[] = (eventShares ?? []).map(s => s.event_id);

    // Categorias partilhadas comigo via calendar_shares
    const { data: categoryShares } = await supabase
      .schema('jarvis')
      .from('calendar_shares')
      .select('owner_id, category')
      .eq('shared_with_id', myBigIntId);

    // Monta a query base
    let query = supabase
      .schema('jarvis')
      .from('events')
      .select('*')
      .gte('start_at', '2020-01-01T00:00:00Z');

    if (sharedEventIds.length > 0) {
      // Meus eventos OU eventos específicos partilhados comigo
      query = query.or(`user_id.eq.${myBigIntId},id.in.(${sharedEventIds.join(',')})`);
    } else {
      query = query.eq('user_id', myBigIntId);
    }

    const { data: myEvents, error } = await query.order('start_at', { ascending: true });
    if (error) throw error;

    // Busca eventos por categoria partilhada (queries separadas para evitar OR complexo)
    let categoryEvents: any[] = [];
    if (categoryShares && categoryShares.length > 0) {
      for (const share of categoryShares) {
        const { data: items } = await supabase
          .schema('jarvis')
          .from('events')
          .select('*')
          .eq('user_id', share.owner_id)
          .eq('category', share.category)
          .gte('start_at', '2020-01-01T00:00:00Z')
          .order('start_at', { ascending: true });

        if (items) categoryEvents = [...categoryEvents, ...items];
      }
    }

    // Junta e deduplica por id
    const all = [...(myEvents ?? []), ...categoryEvents];
    const seen = new Set<string>();
    const unique = all.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
    unique.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());

    return NextResponse.json({ ok: true, events: unique });
  } catch (e: any) {
    console.error('[Calendar GET Error]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── POST: CRIAR NOVO EVENTO ───────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const authUserId = await getAuthUUID(req);
  if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const body = await req.json();

    const { data: userProfile } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    if (!userProfile) {
      return NextResponse.json({ error: 'Perfil de utilizador não encontrado' }, { status: 404 });
    }

    if (!body.title || !body.start_at) {
      return NextResponse.json({ error: 'title e start_at são obrigatórios' }, { status: 400 });
    }

    const { data, error } = await supabase
      .schema('jarvis')
      .from('events')
      .insert({
        user_id:          userProfile.id,
        title:            body.title,
        description:      body.description ?? null,
        location:         body.location ?? null,
        start_at:         body.start_at,
        end_at:           body.end_at ?? null,
        all_day:          body.all_day ?? false,
        category:         body.category ?? 'personal',
        reminder_minutes: body.reminder_minutes ?? null,
        source:           'lev',
      })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ ok: true, event: data }, { status: 201 });
  } catch (e: any) {
    console.error('[Calendar POST Error]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── PUT: ATUALIZAR EVENTO ─────────────────────────────────────────────────────
export async function PUT(req: NextRequest) {
  const authUserId = await getAuthUUID(req);
  if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const body = await req.json();
    const { id, ...updateData } = body;

    if (!id) return NextResponse.json({ error: 'ID do evento obrigatório' }, { status: 400 });

    const { data: userProfile } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    if (!userProfile) {
      return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 });
    }

    // Verifica se é dono ou tem acesso compartilhado
    const { data: event } = await supabase
      .schema('jarvis')
      .from('events')
      .select('user_id, category')
      .eq('id', id)
      .single();

    if (!event) return NextResponse.json({ error: 'Evento não encontrado' }, { status: 404 });

    const isOwner = String(event.user_id) === String(userProfile.id);

    if (!isOwner) {
      // Verifica acesso por categoria
      const { data: catShare } = await supabase
        .schema('jarvis')
        .from('calendar_shares')
        .select('id')
        .eq('owner_id', event.user_id)
        .eq('shared_with_id', userProfile.id)
        .eq('category', event.category)
        .maybeSingle();

      // Verifica acesso por evento específico
      const { data: eventShare } = await supabase
        .schema('jarvis')
        .from('calendar_event_shares')
        .select('id')
        .eq('event_id', id)
        .eq('shared_with_id', userProfile.id)
        .maybeSingle();

      if (!catShare && !eventShare) {
        return NextResponse.json({ error: 'Sem permissão para editar' }, { status: 403 });
      }
    }

    const { data, error } = await supabase
      .schema('jarvis')
      .from('events')
      .update({ ...updateData, updated_at: new Date().toISOString() })
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

// ── DELETE: APAGAR EVENTO ─────────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const authUserId = await getAuthUUID(req);
  if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) return NextResponse.json({ error: 'ID do evento obrigatório' }, { status: 400 });

    const { data: userProfile } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    if (!userProfile) {
      return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 });
    }

    const { data: event } = await supabase
      .schema('jarvis')
      .from('events')
      .select('user_id, category')
      .eq('id', id)
      .single();

    if (!event) return NextResponse.json({ error: 'Evento não encontrado' }, { status: 404 });

    const isOwner = String(event.user_id) === String(userProfile.id);

    if (!isOwner) {
      const { data: catShare } = await supabase
        .schema('jarvis')
        .from('calendar_shares')
        .select('id')
        .eq('owner_id', event.user_id)
        .eq('shared_with_id', userProfile.id)
        .eq('category', event.category)
        .maybeSingle();

      const { data: eventShare } = await supabase
        .schema('jarvis')
        .from('calendar_event_shares')
        .select('id')
        .eq('event_id', id)
        .eq('shared_with_id', userProfile.id)
        .maybeSingle();

      if (!catShare && !eventShare) {
        return NextResponse.json({ error: 'Sem permissão para apagar' }, { status: 403 });
      }
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