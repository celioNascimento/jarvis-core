import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';
import { ShoppingItem, ShoppingMetadata } from '../../../lib/types/shopping'

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token); // Retorna o BigInt como string
  
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  // 1. Busca quais categorias os outros usuários compartilharam COMIGO
  const { data: shares } = await supabase
    .from('shopping_shares')
    .select('owner_id, category')
    .eq('shared_with_id', userId);

  // 2. Monta a query dinâmica: Meus itens + Itens autorizados
  let orQuery = `user_id.eq.${userId}`;
  if (shares && shares.length > 0) {
    const shareConditions = shares.map(s => `and(user_id.eq.${s.owner_id},category.eq.${s.category})`);
    orQuery += `,${shareConditions.join(',')}`;
  }

  // Busca paralela para otimizar performance
  const [itemsRes, metaRes] = await Promise.all([
    supabase
      .from('shopping_items')
      .select('*')
      .or(orQuery) // 👈 Substituímos o eq direto por nossa query dinâmica
      .order('done', { ascending: true })
      .order('created_at', { ascending: false }),
    supabase
      .from('shopping_list_metadata')
      .select('*')
      .eq('user_id', userId) // Metadados (cor, ícones) continuam sendo individuais
  ]);

  if (itemsRes.error || metaRes.error) {
    return NextResponse.json({ error: 'Erro ao buscar dados do banco' }, { status: 500 });
  }

  return NextResponse.json({ 
    items: itemsRes.data as ShoppingItem[], 
    metadata: metaRes.data as ShoppingMetadata[], 
    ok: true 
  });
}

export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { item, category } = await req.json();

  const { data, error } = await supabase
    .from('shopping_items')
    .insert({ 
      user_id: userId, // Ao criar, você sempre é o dono primário
      item, 
      category: category || 'mercado', 
      done: false 
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ item: data as ShoppingItem, ok: true });
}

export async function PATCH(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { id, done } = await req.json();

  // 1. Identifica o item primeiro para saber quem é o dono
  const { data: itemData, error: fetchError } = await supabase
    .from('shopping_items')
    .select('user_id, category')
    .eq('id', id)
    .single();

  if (fetchError || !itemData) return NextResponse.json({ error: 'Item não encontrado' }, { status: 404 });

  // 2. Verifica permissão de edição
  if (String(itemData.user_id) !== String(userId)) {
    // Se não sou o dono, verifico se tenho permissão na tabela shares
    const { data: hasPermission } = await supabase
      .from('shopping_shares')
      .select('id')
      .eq('owner_id', itemData.user_id)
      .eq('shared_with_id', userId)
      .eq('category', itemData.category)
      .single();

    if (!hasPermission) {
      return NextResponse.json({ error: 'Sem permissão para alterar este item' }, { status: 403 });
    }
  }

  // 3. Atualiza o status
  const { error } = await supabase
    .from('shopping_items')
    .update({ done })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) return NextResponse.json({ error: 'ID ausente' }, { status: 400 });

  // 1. Identifica o item para saber quem é o dono
  const { data: itemData, error: fetchError } = await supabase
    .from('shopping_items')
    .select('user_id, category')
    .eq('id', id)
    .single();

  if (fetchError || !itemData) return NextResponse.json({ error: 'Item não encontrado' }, { status: 404 });

  // 2. Verifica permissão de exclusão (mesma lógica do PATCH)
  if (String(itemData.user_id) !== String(userId)) {
    const { data: hasPermission } = await supabase
      .from('shopping_shares')
      .select('id')
      .eq('owner_id', itemData.user_id)
      .eq('shared_with_id', userId)
      .eq('category', itemData.category)
      .single();

    if (!hasPermission) {
      return NextResponse.json({ error: 'Sem permissão para excluir este item' }, { status: 403 });
    }
  }

  // 3. Exclui o item
  const { error } = await supabase
    .from('shopping_items')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}