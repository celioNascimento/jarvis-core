import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { original_task, spice_level, steps, used_in_focus } = await req.json();

  const { data, error } = await supabase
    .from('task_breakdowns')
    .insert({
      user_id: userId,
      original_task,
      spice_level,
      steps,
      used_in_focus: used_in_focus || false,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, breakdown: data });
}