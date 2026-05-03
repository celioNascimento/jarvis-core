import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function PATCH(
  req: NextRequest, 
  { params }: { params: Promise<{ id: string }> }
) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  
  // A API recebe apenas o que mudou do App (ex: { agenda_enabled: true })
  const partialSettings = await req.json();

  // 1. Busca os settings atuais no banco
  const { data: rel } = await supabase
    .from('relationships')
    .select('settings')
    .eq('id', id)
    .single();

  // 2. Faz a mescla (merge) do histórico com a nova alteração
  const mergedSettings = {
    ...(rel?.settings || {}),
    ...partialSettings
  };

  // 3. Salva o objeto consolidado
  const { error } = await supabase
    .from('relationships')
    .update({ settings: mergedSettings })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}