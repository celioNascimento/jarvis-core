// app/api/routines/checkin/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { coreGetCheckins, coreProcessCheckin } from '@/lib/services/routines.service';

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

    const { searchParams } = new URL(req.url);
    const date = searchParams.get('date') ?? new Date().toISOString().split('T')[0];

    const checkins = await coreGetCheckins(userId, date);
    return NextResponse.json({ checkins });
  } catch (err: any) {
    console.error('[checkins GET]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const result = await coreProcessCheckin(userId, body);
    
    return NextResponse.json(result);
  } catch (err: any) {
    console.error('[checkin POST]', err);
    const status = err.message.includes('obrigatório') || err.message.includes('inválido') ? 400 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
