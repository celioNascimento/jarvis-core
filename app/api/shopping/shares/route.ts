import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { shared_with_id, category } = await req.json();

  // Insere a permissão (o unique na tabela evita duplicados)
  const { error } = await supabase
    .from('shopping_shares')
    .insert({
      owner_id: userId,
      shared_with_id,
      category
    });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const shared_with_id = searchParams.get('shared_with_id');
  const category = searchParams.get('category');

  if (!shared_with_id || !category) {
    return NextResponse.json({ error: 'Parâmetros ausentes' }, { status: 400 });
  }

  // Remove a permissão específica
  const { error } = await supabase
    .from('shopping_shares')
    .delete()
    .eq('owner_id', userId)
    .eq('shared_with_id', shared_with_id)
    .eq('category', category);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}