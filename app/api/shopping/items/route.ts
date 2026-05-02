// app/api/shopping/items/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ── GET /api/shopping/items ───────────────────────────────────────────────────
// Retorna itens próprios + itens compartilhados com o usuário (via shopping_shares)
export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Busca auth_user_id para usar em shopping_items (user_id é text/uuid lá)
  const { data: userRow } = await supabase
    .schema('jarvis')
    .from('users')
    .select('auth_user_id')
    .eq('id', userId)
    .maybeSingle();

  if (!userRow) return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });

  // Itens próprios (não arquivados)
  const { data: ownItems, error: ownError } = await supabase
    .schema('jarvis')
    .from('shopping_items')
    .select('id, item, category, done, links')
    .eq('user_id', userRow.auth_user_id)
    .eq('archived', false)
    .order('created_at', { ascending: false });

  if (ownError) return NextResponse.json({ error: ownError.message }, { status: 500 });

  // Categorias compartilhadas com este usuário por outros
  const { data: sharedWith } = await supabase
    .schema('jarvis')
    .from('shopping_shares')
    .select('owner_id, category')
    .eq('shared_with_id', userId);

  let sharedItems: any[] = [];

  if (sharedWith && sharedWith.length > 0) {
    // Para cada par (owner, category), busca os itens do dono
    // Busca auth_user_id dos donos
    const ownerIds = [...new Set(sharedWith.map(s => s.owner_id))];
    const { data: owners } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id, auth_user_id')
      .in('id', ownerIds);

    if (owners) {
      for (const share of sharedWith) {
        const owner = owners.find(o => o.id === share.owner_id);
        if (!owner) continue;

        const { data: items } = await supabase
          .schema('jarvis')
          .from('shopping_items')
          .select('id, item, category, done, links')
          .eq('user_id', owner.auth_user_id)
          .eq('category', share.category)
          .eq('archived', false)
          .order('created_at', { ascending: false });

        if (items) sharedItems = [...sharedItems, ...items];
      }
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

  const { data: userRow } = await supabase
    .schema('jarvis')
    .from('users')
    .select('auth_user_id')
    .eq('id', userId)
    .maybeSingle();

  if (!userRow) return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });

  const body = await req.json();
  const { item, category } = body;

  if (!item?.trim()) return NextResponse.json({ error: 'Item obrigatório' }, { status: 400 });

  const validCategories = ['mercado','higiene','farmacia','academia','reforma','casa','roupas','tecnologia','outros'];
  if (!validCategories.includes(category)) {
    return NextResponse.json({ error: 'Categoria inválida' }, { status: 400 });
  }

  const { data: newItem, error } = await supabase
    .schema('jarvis')
    .from('shopping_items')
    .insert({
      user_id: userRow.auth_user_id,
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
// Marca/desmarca item como concluído
export async function PATCH(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: userRow } = await supabase
    .schema('jarvis')
    .from('users')
    .select('auth_user_id')
    .eq('id', userId)
    .maybeSingle();

  if (!userRow) return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });

  const { id, done } = await req.json();
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 });

  // Verifica posse: o item precisa pertencer ao usuário
  // (quem visualiza item compartilhado pode marcar como feito também)
  const { error } = await supabase
    .schema('jarvis')
    .from('shopping_items')
    .update({ done })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

// ── DELETE /api/shopping/items ────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: userRow } = await supabase
    .schema('jarvis')
    .from('users')
    .select('auth_user_id')
    .eq('id', userId)
    .maybeSingle();

  if (!userRow) return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 });

  // Só o dono pode deletar
  const { error } = await supabase
    .schema('jarvis')
    .from('shopping_items')
    .delete()
    .eq('id', id)
    .eq('user_id', userRow.auth_user_id); // garante posse

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}