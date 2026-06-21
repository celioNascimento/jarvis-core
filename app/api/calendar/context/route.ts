// ============================================================
// app/api/calendar/context/route.ts
// GET /api/calendar/context?days=7
// Retorna bloco de texto formatado para injeção no prompt do Jarvis
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const authUserId = req.headers.get('x-user-id');
  if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .single();

  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const days = parseInt(searchParams.get('days') ?? '7');

  const { data, error } = await supabase.rpc('get_calendar_context_for_jarvis', {
    p_user_id: user.id,
    p_days:    days,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ context: data });
}