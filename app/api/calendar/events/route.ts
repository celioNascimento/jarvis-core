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

async function getUserProfile(authUserId: string) {
  const { data } = await supabase
    .schema('jarvis')
    .from('users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .single();
  return data;
}

// ── GET: BUSCAR EVENTOS ───────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const authUserId = await getAuthUUID(req);
  if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const userProfile = await getUserProfile(authUserId);
    if (!userProfile) {
      return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 });
    }

    const { searchParams } = new URL(req.url);
    const from = searchParams.get('from') ?? new Date().toISOString().split('T')[0];
    const to   = searchParams.get('to')   ?? null;

    const myBigIntId    = userProfile.id;
    const myBigIntIdStr = String(myBigIntId);

    // 1. Eventos explicitamente compartilhados comigo por ID
    const { data: eventShares } = await supabase
      .schema('jarvis')
      .from('calendar_event_shares')
      .select('event_id')
      .eq('shared_with_id', myBigIntId);

    const sharedEventIds: string[] = (eventShares ?? []).map(s => s.event_id);

    // 2. Categorias compartilhadas comigo
    const { data: categoryShares } = await supabase
      .schema('jarvis')
      .from('calendar_shares')
      .select('owner_id, category')
      .eq('shared_with_id', myBigIntId);

    // 3. Query base — meus eventos + compartilhados por ID
    let query = supabase
      .schema('jarvis')
      .from('events')
      .select('*')
      .gte('start_at', from);

    if (to) query = query.lte('start_at', to);

    query = sharedEventIds.length > 0
      ? query.or(`user_id.eq.${myBigIntId},id.in.(${sharedEventIds.join(',')})`)
      : query.eq('user_id', myBigIntId);

    const { data: baseEvents, error } = await query.order('start_at', { ascending: true });
    if (error) throw error;

    // 4. Eventos por categoria compartilhada
    let categoryEvents: any[] = [];
    for (const share of categoryShares ?? []) {
      let catQuery = supabase
        .schema('jarvis')
        .from('events')
        .select('*')
        .eq('user_id', share.owner_id)
        .eq('category', share.category)
        .gte('start_at', from)
        .order('start_at', { ascending: true });

      if (to) catQuery = catQuery.lte('start_at', to);

      const { data: items } = await catQuery;
      if (items) categoryEvents = [...categoryEvents, ...items];
    }

    // 5. Marca shared_from_partner, mescla e deduplica
    const marked = [
      ...(baseEvents ?? []).map(e => ({
        ...e,
        shared_from_partner: String(e.user_id) !== myBigIntIdStr,
      })),
      ...categoryEvents.map(e => ({ ...e, shared_from_partner: true })),
    ];

    const seen = new Set<string>();
    const unique = marked
      .filter(e => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      })
      .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());

    return NextResponse.json({ ok: true, events: unique });
  } catch (e: any) {
    console.error('[Calendar GET Error]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── POST: CRIAR EVENTO ────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const authUserId = await getAuthUUID(req);
  if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const body = await req.json();

    if (!body.title || !body.start_at) {
      return NextResponse.json({ error: 'title e start_at são obrigatórios' }, { status: 400 });
    }

    const userProfile = await getUserProfile(authUserId);
    if (!userProfile) {
      return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 });
    }

    const { data, error } = await supabase
      .schema('jarvis')
      .from('events')
      .insert({
        user_id:          userProfile.id,
        title:            body.title,
        description:      body.description   ?? null,
        location:         body.location      ?? null,
        start_at:         body.start_at,
        end_at:           body.end_at        ?? null,
        all_day:          body.all_day       ?? false,
        category:         body.category      ?? 'personal',
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

// ── HELPER: verifica se o usuário tem acesso de escrita ao evento ─────────────
async function canWrite(eventId: string, myBigIntId: number): Promise<boolean> {
  const { data: event } = await supabase
    .schema('jarvis')
    .from('events')
    .select('user_id, category')
    .eq('id', eventId)
    .single();

  if (!event) return false;
  if (String(event.user_id) === String(myBigIntId)) return true;

  // Acesso por categoria compartilhada
  const { data: catShare } = await supabase
    .schema('jarvis')
    .from('calendar_shares')
    .select('id')
    .eq('owner_id', event.user_id)
    .eq('shared_with_id', myBigIntId)
    .eq('category', event.category)
    .maybeSingle();

  if (catShare) return true;

  // Acesso por evento específico
  const { data: eventShare } = await supabase
    .schema('jarvis')
    .from('calendar_event_shares')
    .select('id')
    .eq('event_id', eventId)
    .eq('shared_with_id', myBigIntId)
    .maybeSingle();

  return !!eventShare;
}

// ── PUT: ATUALIZAR EVENTO ─────────────────────────────────────────────────────
export async function PUT(req: NextRequest) {
  const authUserId = await getAuthUUID(req);
  if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const body = await req.json();
    const { id, ...updateData } = body;

    if (!id) return NextResponse.json({ error: 'ID do evento obrigatório' }, { status: 400 });

    const userProfile = await getUserProfile(authUserId);
    if (!userProfile) {
      return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 });
    }

    if (!(await canWrite(id, userProfile.id))) {
      return NextResponse.json({ error: 'Sem permissão para editar' }, { status: 403 });
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

    const userProfile = await getUserProfile(authUserId);
    if (!userProfile) {
      return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 });
    }

    if (!(await canWrite(id, userProfile.id))) {
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