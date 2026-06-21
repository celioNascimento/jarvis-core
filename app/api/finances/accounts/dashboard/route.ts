// app/api/finances/accounts/dashboard/route.ts — V2
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { resolveUser } from '@/lib/finances/auth';

export async function GET(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { data, error } = await supabase.rpc('get_accounts_dashboard', {
      p_jarvis_user_id: user.jarvisUserId,
    });

    if (error) throw error;
    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}