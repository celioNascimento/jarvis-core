// app/api/tdah/focus_sessions/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { coreCreateFocusSession } from '@/lib/services/tdah.service';

async function getUserId(req: NextRequest): Promise<number | null> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return null;
  const { data } = await supabase.schema('jarvis').from('users').select('id').eq('auth_user_id', user.id).single();
  return data?.id ?? null;
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await req.json();
    const session = await coreCreateFocusSession(userId, payload);
    
    return NextResponse.json({ success: true, session });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
