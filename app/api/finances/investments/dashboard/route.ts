// app/api/finances/investments/dashboard/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

async function resolveUser(req: NextRequest) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim();
  if (!token) return null;
  const { createClient: c } = await import('@supabase/supabase-js');
  const { data: { user } } = await c(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!).auth.getUser(token);
  if (!user) return null;
  const { data: j } = await supabase.from('users').select('id').eq('auth_user_id', user.id).maybeSingle();
  return j ? { authUserId: user.id, jarvisUserId: j.id as number } : null;
}

export async function GET(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { data, error } = await supabase.rpc('get_investment_dashboard', {
      p_jarvis_user_id: user.jarvisUserId,
    });

    if (error) throw error;
    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}