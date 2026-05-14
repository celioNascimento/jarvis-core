// app/api/calendar/shares/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';
import { getActivePartnersBySetting } from '@/lib/modules/relationships';

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    const userId = await getUserFromToken(token);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const category = searchParams.get('category');
    if (!category) return NextResponse.json({ error: 'category obrigatório' }, { status: 400 });

    const partners = await getActivePartnersBySetting(userId, 'agenda_enabled');
    if (partners.length === 0) return NextResponse.json({ ok: true, options: [] });

    const partnerIds = partners.map(p => p.partnerId);

    const { data: outgoing } = await supabase.from('calendar_shares').select('shared_with_id').eq('owner_id', userId).eq('category', category).in('shared_with_id', partnerIds);
    const { data: incoming } = await supabase.from('calendar_shares').select('owner_id').eq('shared_with_id', userId).eq('category', category).in('owner_id', partnerIds);

    const activeOutgoing = new Set(outgoing?.map(s => String(s.shared_with_id)));
    const activeIncoming = new Set(incoming?.map(s => String(s.owner_id)));

    const options = partners.map(p => ({
      user_id: p.partnerUUID,
      bigint_id: p.partnerId,
      contact_name: p.displayName,
      is_active: activeOutgoing.has(String(p.partnerId)),
      received_from_partner: activeIncoming.has(String(p.partnerId)),
    }));

    return NextResponse.json({ ok: true, options });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    const userId = await getUserFromToken(token);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { category, shared_with_id, active } = await req.json();

    // ADICIONADO: Validação rigorosa de campos obrigatórios
    if (!category || !shared_with_id || typeof active !== 'boolean') {
      return NextResponse.json({ error: 'Campos category, shared_with_id e active são obrigatórios' }, { status: 400 });
    }

    if (active) {
      const { error } = await supabase.from('calendar_shares').upsert({ 
        owner_id: userId, 
        shared_with_id, 
        category 
      }, { onConflict: 'owner_id,shared_with_id,category' });
      
      if (error) throw error;
    } else {
      const { error } = await supabase.from('calendar_shares').delete()
        .eq('owner_id', userId)
        .eq('shared_with_id', shared_with_id)
        .eq('category', category);
        
      if (error) throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
