    import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

export async function POST(req: Request) {
  const { reminder_id, user_id, minutes } = await req.json();

  if (!reminder_id || !user_id || !minutes || minutes <= 0) {
    return NextResponse.json({ error: 'reminder_id, user_id e minutes (>0) são obrigatórios' }, { status: 400 });
  }

  // Buscar lembrete atual
  const { data: reminder, error: fetchError } = await supabase
    .from('reminders')
    .select('*')
    .eq('id', reminder_id)
    .eq('user_id', user_id)
    .single();

  if (fetchError || !reminder) {
    return NextResponse.json({ error: 'Lembrete não encontrado' }, { status: 404 });
  }

  const newScheduledTime = new Date(Date.now() + minutes * 60 * 1000);

  const { error: updateError } = await supabase
    .from('reminders')
    .update({
      scheduled_time: newScheduledTime.toISOString(),
      status: 'pending',
      updated_at: new Date().toISOString(),
    })
    .eq('id', reminder_id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, message: `Lembrete adiado por ${minutes} minutos.` });
}