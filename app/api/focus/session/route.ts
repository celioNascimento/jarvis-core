import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { started_at, ended_at, task_original, steps_completed, steps_total, cancelled, reward_chosen, halt_triggered } = body;

  const { data, error } = await supabase
    .from('focus_sessions')
    .insert({
      user_id: userId,
      started_at: started_at || new Date().toISOString(),
      ended_at,
      task_original,
      steps_completed,
      steps_total,
      cancelled,
      reward_chosen,
      halt_triggered,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, session: data });
}