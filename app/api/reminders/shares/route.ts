// app/api/reminders/shares/route.ts
// Motor V1.5.0 — Bypass de Syntax Error 42601 (Parallel Native Queries)

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { data: authData } = await supabase.auth.getUser(token);
    if (!authData?.user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    const authUserId = authData.user.id; // UUID String com Hifens

    const { searchParams } = new URL(req.url);
    const reminder_id = searchParams.get('reminder_id');
    if (!reminder_id) return NextResponse.json({ error: 'reminder_id ausente' }, { status: 400 });

    // 1. DUAL QUERY (O BYPASS DO ERRO 42601)
    // Fazemos duas requisições nativas limpas em vez de usar um `.or()` com string
    const [resA, resB] = await Promise.all([
      supabase.schema('jarvis').from('relationships').select('user_id_a, user_id_b, contact_name').eq('status', 'active').eq('user_id_a', authUserId),
      supabase.schema('jarvis').from('relationships').select('user_id_a, user_id_b, contact_name').eq('status', 'active').eq('user_id_b', authUserId)
    ]);

    if (resA.error) throw resA.error;
    if (resB.error) throw resB.error;

    // Junta e deduplica os resultados
    const relationships = [...(resA.data || []), ...(resB.data || [])];
    if (relationships.length === 0) {
      return NextResponse.json({ ok: true, options: [] });
    }

    // Coleta os UUIDs dos parceiros
    const partnerUUIDs = Array.from(new Set(relationships.map(rel => 
      rel.user_id_a === authUserId ? rel.user_id_b : rel.user_id_a
    )));

    if (partnerUUIDs.length === 0) return NextResponse.json({ ok: true, options: [] });

    // 2. Traduz os UUIDs para IDs numéricos (BigInt) no Schema Jarvis
    const { data: partnerUsers, error: usersError } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id, auth_user_id, nickname')
      .in('auth_user_id', partnerUUIDs);

    if (usersError) throw usersError;
    if (!partnerUsers || partnerUsers.length === 0) {
      return NextResponse.json({ ok: true, options: [] });
    }

    const partnerBigintIds = partnerUsers.map(u => u.id);

    // 3. Busca se os parceiros já estão marcados neste lembrete específico
    const { data: shares, error: sharesError } = await supabase
      .schema('jarvis')
      .from('reminder_shares')
      .select('shared_with_id')
      .eq('reminder_id', reminder_id)
      .eq('active', true)
      .in('shared_with_id', partnerBigintIds);

    if (sharesError) throw sharesError;

    const activeIds = new Set(shares?.map(s => String(s.shared_with_id)));

    // 4. Monta a lista visual de opções para o Modal de Compartilhamento
    const options = partnerUsers.map(u => {
      const relDoc = relationships.find(rel => rel.user_id_a === u.auth_user_id || rel.user_id_b === u.auth_user_id);
      return {
        user_id: u.auth_user_id, // Identificador front-end
        bigint_id: u.id,         // Identificador banco
        contact_name: relDoc?.contact_name || u.nickname || 'Parceiro',
        is_active: activeIds.has(String(u.id)),
      };
    });

    return NextResponse.json({ ok: true, options });
  } catch (e: any) {
    console.error('[Reminder Shares GET] Erro crítico:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { data: authData } = await supabase.auth.getUser(token);
    if (!authData?.user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    const authUserId = authData.user.id;

    const { reminder_id, shared_with_id, active } = await req.json();
    if (!reminder_id || !shared_with_id || typeof active !== 'boolean') {
      return NextResponse.json(
        { error: 'reminder_id, shared_with_id e active são obrigatórios' },
        { status: 400 }
      );
    }

    // Identifica o número bigint do criador original
    const { data: currentUser } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    if (!currentUser) return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });

    // Valida a posse (apenas o dono pode compartilhar)
    const { data: reminder, error: remError } = await supabase
      .schema('jarvis')
      .from('reminders')
      .select('user_id')
      .eq('id', reminder_id)
      .maybeSingle();

    if (remError || !reminder || reminder.user_id !== currentUser.id) {
      return NextResponse.json({ error: 'Lembrete não encontrado ou permissão negada' }, { status: 404 });
    }

    // Persiste o toggle de compartilhamento com chaves estritas e limpas
    const { error } = await supabase
      .schema('jarvis')
      .from('reminder_shares')
      .upsert(
        { reminder_id, shared_with_id: Number(shared_with_id), active },
        { onConflict: 'reminder_id,shared_with_id' }
      );

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[Reminder Shares POST] Erro crítico:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
