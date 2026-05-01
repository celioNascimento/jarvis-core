import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  
  const { data, error } = await supabase
    .from('shopping_items')
    .select('*')
    .eq('user_id', userId)
    .order('done', { ascending: true }) // Itens pendentes primeiro
    .order('created_at', { ascending: false });

  return NextResponse.json({ items: data, ok: !error });
}

export async function PATCH(req: NextRequest) {
  const { id, done } = await req.json();
  const { error } = await supabase
    .from('shopping_items')
    .update({ done })
    .eq('id', id);

  return NextResponse.json({ ok: !error });
}