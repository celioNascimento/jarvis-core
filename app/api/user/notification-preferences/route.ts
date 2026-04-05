import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const userId = url.searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId obrigatório' }, { status: 400 });

  const { data, error } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', userId)
    .eq('channel', 'push');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data?.[0] || {});
}

export async function POST(req: Request) {
  const body = await req.json();
  const { user_id, enabled, quiet_start, quiet_end, max_per_day, min_relevance_score } = body;

  const { data, error } = await supabase
    .from('notification_preferences')
    .upsert({
      user_id,
      channel: 'push',
      enabled,
      quiet_start,
      quiet_end,
      max_per_day,
      min_relevance_score,
    }, { onConflict: 'user_id,channel' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}