// app/api/routines/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { coreUpdateRoutine, coreDeleteRoutine } from '@/lib/services/routines.service';

async function getUserId(req: NextRequest): Promise<number | null> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  const { data } = await supabase.from('users').select('id').eq('auth_user_id', user.id).single();
  return data?.id ?? null;
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    await coreDeleteRoutine(userId, id);
    return NextResponse.json({ deleted: true });
  } catch (err: any) {
    console.error('[routines DELETE]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const body = await req.json();
    
    const routine = await coreUpdateRoutine(userId, id, body);
    return NextResponse.json({ routine });
  } catch (err: any) {
    console.error('[routines PATCH]', err);
    const status = err.message.includes('Nenhum campo') ? 400 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
