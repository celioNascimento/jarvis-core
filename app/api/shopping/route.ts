import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Busca itens e metadados em paralelo
  const [itemsRes, metaRes] = await Promise.all([
    supabase.from('shopping_items').select('*').eq('user_id', userId).order('done', { ascending: true }),
    supabase.from('shopping_list_metadata').select('*').eq('user_id', userId)
  ]);

  if (itemsRes.error || metaRes.error) {
    return NextResponse.json({ error: 'Erro ao buscar dados' }, { status: 500 });
  }

  return NextResponse.json({ 
    items: itemsRes.data, 
    metadata: metaRes.data, // Aqui vêm os wallpapers e links por categoria
    ok: true 
  });
}

// Adicione estes métodos ao seu arquivo de rota
export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token); // Retorna o bigint numérico
  
  const { item, category } = await req.json();

  const { data, error } = await supabase
    .from('shopping_items')
    .insert({ user_id: userId, item, category: category || 'mercado', done: false })
    .select()
    .single();

  return NextResponse.json({ item: data, ok: !error });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  const { error } = await supabase
    .from('shopping_items')
    .delete()
    .eq('id', id);

  return NextResponse.json({ ok: !error });
}