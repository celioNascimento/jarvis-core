// ============================================================
// app/api/calendar/context/route.ts
// GET /api/calendar/context?days=7
// Retorna bloco de texto formatado para injeção no prompt do Jarvis
// ============================================================
 
// Salvar como: app/api/calendar/context/route.ts
 
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
 
const supabaseCtx = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
 
export async function GET_CONTEXT(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const authUserId = req.headers.get('x-user-id');
  if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 
  const { data: user } = await supabaseCtx
    .schema('jarvis')
    .from('users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .single();
 
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
 
  const days = parseInt(searchParams.get('days') ?? '7');
 
  const { data, error } = await supabaseCtx.rpc('get_calendar_context_for_jarvis', {
    p_user_id: user.id,
    p_days:    days,
  });
 
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ context: data });
}