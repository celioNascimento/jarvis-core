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