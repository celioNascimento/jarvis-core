// ============================================================
// app/api/calendar/upcoming/route.ts
// GET /api/calendar/upcoming?days=7&category=
// Usado pelo Jarvis no contexto e pelo DashboardScreen
// ============================================================
 
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
 
 
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const authUserId = req.headers.get('x-user-id');
  if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 
  const { data: user } = await supabase
    .schema('jarvis')
    .from('users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .single();
 
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
 
  const days     = parseInt(searchParams.get('days') ?? '7');
  const category = searchParams.get('category') ?? null;
 
  const { data: events, error } = await supabase.rpc('get_upcoming_events', {
    p_user_id:  user.id,
    p_days:     days,
    p_category: category,
  });
 
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ events });
}
