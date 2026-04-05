import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

export async function POST(req: Request) {
  const { reminder_id, user_id } = await req.json();

  if (!reminder_id || !user_id) {
    return NextResponse.json({ error: 'reminder_id e user_id são obrigatórios' }, { status: 400 });
  }

  const { error } = await supabase
    .from('reminders')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', reminder_id)
    .eq('user_id', user_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, message: 'Lembrete concluído.' });
}