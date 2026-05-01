import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';
import { ShoppingItem, ShoppingMetadata } from '../../../lib/types/shopping'

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token); // Retorna o BigInt como string
  
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  // Busca paralela para otimizar performance
  const [itemsRes, metaRes] = await Promise.all([
    supabase
      .from('shopping_items')
      .select('*')
      .eq('user_id', userId)
      .order('done', { ascending: true })
      .order('created_at', { ascending: false }),
    supabase
      .from('shopping_list_metadata')
      .select('*')
      .eq('user_id', userId)
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
      user_id: userId, 
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

  const { error } = await supabase
    .from('shopping_items')
    .update({ done })
    .eq('id', id)
    .eq('user_id', userId); // Segurança extra: garante que o item pertence ao usuário

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

  const { error } = await supabase
    .from('shopping_items')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}