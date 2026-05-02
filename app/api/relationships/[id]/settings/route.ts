import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { shopping_enabled } = await req.json();

  const { error } = await supabase
    .from('relationships')
    .update({ settings: { shopping_enabled } })
    .eq('id', params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}