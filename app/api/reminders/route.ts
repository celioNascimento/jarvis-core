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

// ── GET: BUSCAR LEMBRETES ───────────────────────────────────────────────────
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
        return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 });
    }

    const { data: reminders, error } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select('*')
      .eq('user_id', userProfile.id)
      .order('scheduled_time', { ascending: true, nullsFirst: false });

    if (error) throw error;

    return NextResponse.json({ ok: true, reminders });
  } catch (e: any) {
    console.error('[Reminders GET Error]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── POST: CRIAR NOVO LEMBRETE ───────────────────────────────────────────────
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
        return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 });
    }

    const { data, error } = await supabase
      .schema('jarvis')
      .from('reminders')
      .insert({
        user_id: userProfile.id,
        title: body.title,
        type: body.type || 'temporary',
        scheduled_time: body.scheduled_time || null,
        frequency: body.frequency || null,
        status: 'pending'
      })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ ok: true, reminder: data });
  } catch (e: any) {
    console.error('[Reminders POST Error]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── PUT: ATUALIZAR LEMBRETE ─────────────────────────────────────────────────
export async function PUT(req: NextRequest) {
  const authUserId = await getAuthUUID(req);
  if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const body = await req.json();
    const { id, ...updateData } = body;

    if (!id) return NextResponse.json({ error: 'ID do lembrete obrigatório' }, { status: 400 });

    const { data: userProfile } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    // Validação de segurança
    const { data: reminder } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select('user_id')
      .eq('id', id)
      .single();

    if (!reminder || reminder.user_id !== userProfile?.id) {
        return NextResponse.json({ error: 'Sem permissão' }, { status: 403 });
    }

    const { data, error } = await supabase
      .schema('jarvis')
      .from('reminders')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ ok: true, reminder: data });
  } catch (e: any) {
    console.error('[Reminders PUT Error]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── DELETE: APAGAR LEMBRETE ─────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const authUserId = await getAuthUUID(req);
  if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) return NextResponse.json({ error: 'ID do lembrete obrigatório' }, { status: 400 });

    const { data: userProfile } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    // Validação de segurança
    const { data: reminder } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select('user_id')
      .eq('id', id)
      .single();

    if (!reminder || reminder.user_id !== userProfile?.id) {
        return NextResponse.json({ error: 'Sem permissão' }, { status: 403 });
    }

    const { error } = await supabase
      .schema('jarvis')
      .from('reminders')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[Reminders DELETE Error]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}