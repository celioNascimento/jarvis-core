// app/api/finances/summary/route.ts
// GET — resumo financeiro por período

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getFinanceSummary, getBudgetsWithUsage } from '@/lib/finances/db';
import { resolveUser } from '@/lib/finances/auth';


const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);


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
