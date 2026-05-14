// app/api/reminders/shares/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';
import { getActivePartnersBySetting } from '@/lib/modules/relationships';

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    const userId = await getUserFromToken(token);
    if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const reminder_id = searchParams.get('reminder_id');
    if (!reminder_id) return NextResponse.json({ error: 'reminder_id ausente' }, { status: 400 });

    // 1. Partners via helper unificado
    const partners = await getActivePartnersBySetting(userId, 'agenda_enabled');
    if (partners.length === 0) return NextResponse.json({ ok: true, options: [] });

    const partnerBigintIds = partners.map(p => p.partnerId);

    // 2. Shares ativos
    const { data: shares } = await supabase
      .from('reminder_shares')
      .select('shared_with_id')
      .eq('reminder_id', reminder_id)
      .eq('active', true)
      .in('shared_with_id', partnerBigintIds);

    const activeIds = new Set(shares?.map(s => String(s.shared_with_id)));

    // 3. Monta opções
    const options = partners.map(p => ({
      user_id: p.partnerUUID,
      bigint_id: p.partnerId,
      contact_name: p.displayName,
      is_active: activeIds.has(String(p.partnerId)),
    }));

    return NextResponse.json({ ok: true, options });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const { reminder_id, shared_with_id, active } = await req.json();

    if (!reminder_id || !shared_with_id || typeof active !== 'boolean') {
      return NextResponse.json(
        { error: 'reminder_id, shared_with_id e active são obrigatórios' },
        { status: 400 }
      );
    }

    // Confirma posse do lembrete
    const { data: reminder } = await supabase
      .from('reminders')
      .select('user_id')
      .eq('id', reminder_id)
      .maybeSingle();

    if (!reminder || reminder.user_id !== userId) {
      return NextResponse.json({ error: 'Lembrete não encontrado' }, { status: 404 });
    }

    const { error } = await supabase
      .from('reminder_shares')
      .upsert(
        { reminder_id, shared_with_id: Number(shared_with_id), active },
        { onConflict: 'reminder_id,shared_with_id' }
      );

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[Reminder Shares POST] Erro:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
