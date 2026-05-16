// app/api/routines/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { coreGetRoutines, coreCreateRoutine } from '@/lib/services/routines.service';

async function getUserId(req: NextRequest): Promise<number | null> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  const { data } = await supabase.from('users').select('id').eq('auth_user_id', user.id).single();
  return data?.id ?? null;
}

export async function GET(req: NextRequest) {
  try {
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const routines = await coreGetRoutines(userId);
    return NextResponse.json({ routines });
  } catch (err: any) {
    console.error('[routines GET] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const routine = await coreCreateRoutine(userId, body);
    return NextResponse.json({ routine }, { status: 201 });
  } catch (err: any) {
    console.error('[routines POST] Error:', err);
    const status = err.message.includes('obrigatórios') || err.message.includes('inválido') ? 400 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
