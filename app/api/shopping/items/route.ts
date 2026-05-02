// app/api/shopping/items/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ── GET /api/shopping/items ───────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token); // bigint numérico
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // shopping_items.user_id é TEXT com o id numérico (ex: "8595482774")
  const userIdStr = String(userId);

  // Itens próprios
  const { data: ownItems, error: ownError } = await supabase
    .from('shopping_items')
    .select('id, item, category, done, links')
    .eq('user_id', userIdStr)
    .eq('archived', false)
    .order('created_at', { ascending: false });

  if (ownError) return NextResponse.json({ error: ownError.message }, { status: 500 });

  // Categorias que outros compartilharam com este usuário
  const { data: sharedWith } = await supabase
    .from('shopping_shares')
    .select('owner_id, category')
    .eq('shared_with_id', userId);

  let sharedItems: any[] = [];

  if (sharedWith && sharedWith.length > 0) {
    for (const share of sharedWith) {
      const { data: items } = await supabase
        .from('shopping_items')
        .select('id, item, category, done, links')
        .eq('user_id', String(share.owner_id))
        .eq('category', share.category)
        .eq('archived', false)
        .order('created_at', { ascending: false });

      if (items) sharedItems = [...sharedItems, ...items];
    }
  }

  // Junta e deduplica por id
  const all = [...(ownItems ?? []), ...sharedItems];
  const seen = new Set<string>();
  const unique = all.filter(i => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });

  return NextResponse.json({ ok: true, items: unique });
}

// ── POST /api/shopping/items ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { item, category } = body;

  if (!item?.trim()) return NextResponse.json({ error: 'Item obrigatório' }, { status: 400 });

  const validCategories = ['mercado', 'higiene', 'farmacia', 'academia', 'reforma', 'casa', 'roupas', 'tecnologia', 'outros'];
  if (!validCategories.includes(category)) {
    return NextResponse.json({ error: 'Categoria inválida' }, { status: 400 });
  }

  const { data: newItem, error } = await supabase
    .from('shopping_items')
    .insert({
      user_id: String(userId),
      item: item.trim(),
      category,
      done: false,
    })
    .select('id, item, category, done, links')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, item: newItem });
}

// ── PATCH /api/shopping/items ─────────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { id, done, links } = body;

  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 });

  // Monta apenas os campos enviados
  const updates: Record<string, any> = {};
  if (typeof done === 'boolean') updates.done = done;
  if (Array.isArray(links)) updates.links = links;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nada para atualizar' }, { status: 400 });
  }

  updates.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from('shopping_items')
    .update(updates)
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

// ── DELETE /api/shopping/items ────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 });

  const { error } = await supabase
    .from('shopping_items')
    .delete()
    .eq('id', id)
    .eq('user_id', String(userId));

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}