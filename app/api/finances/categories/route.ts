// app/api/finances/categories/route.ts
// GET — lista categorias hierárquicas (globais + do usuário)
// POST — cria categoria customizada

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

async function resolveUser(req: NextRequest) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim();
  if (!token) return null;
  const { createClient: c } = await import('@supabase/supabase-js');
  const { data: { user } } = await c(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!).auth.getUser(token);
  if (!user) return null;
  const { data: j } = await supabase.from('users').select('id').eq('auth_user_id', user.id).maybeSingle();
  return j ? { authUserId: user.id, jarvisUserId: j.id as number } : null;
}

export async function GET(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const type = searchParams.get('type'); // expense | income | both | null (todos)

    let query = supabase
      .from('categories')
      .select('id, name, icon, color, type, parent_id, sort_order, is_system, user_id')
      .or(`user_id.is.null,user_id.eq.${user.authUserId}`)
      .order('sort_order')
      .order('name');

    if (type && type !== 'both') {
      query = query.or(`type.eq.${type},type.eq.both,type.is.null`);
    }

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const body = await req.json();
    const { name, icon, color, type, parent_id } = body;

    if (!name) return NextResponse.json({ error: 'name obrigatório' }, { status: 400 });

    // Conta quantas categorias o usuário já tem (limite soft de 50)
    const { count } = await supabase
      .from('categories')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.authUserId);

    if ((count ?? 0) >= 50)
      return NextResponse.json({ error: 'Limite de 50 categorias customizadas atingido.' }, { status: 422 });

    const { data, error } = await supabase
      .from('categories')
      .insert({
        name: name.trim(),
        icon:      icon || '📦',
        color:     color || '#9E9E9E',
        type:      type || 'expense',
        parent_id: parent_id || null,
        user_id:   user.authUserId,
        is_system: false,
        sort_order: 999,
      })
      .select('*')
      .single();

    if (error) throw error;
    return NextResponse.json({ ok: true, data }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}