// app/api/finances/summary/route.ts
// GET — resumo financeiro por período

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getFinanceSummary, getBudgetsWithUsage } from '@/lib/finances/db';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

async function resolveUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;

  const { createClient: c } = await import('@supabase/supabase-js');
  const authClient = c(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const { data: { user } } = await authClient.auth.getUser(token);
  if (!user) return null;

  const { data: jarvisUser } = await supabase
    .from('users')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  return jarvisUser ? { authUserId: user.id, jarvisUserId: jarvisUser.id } : null;
}

export async function GET(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const period = (searchParams.get('period') || 'month') as any;

    const [summary, budgets] = await Promise.all([
      getFinanceSummary(user.jarvisUserId, period),
      getBudgetsWithUsage(user.jarvisUserId, user.authUserId),
    ]);

    return NextResponse.json({ ok: true, summary, budgets });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}