// app/api/reminders/shares/route.ts
// Motor V1.1.0 — Resolução de Conflitos de Tipos (BigInt vs UUID) + Flat Queries

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    const authUserId = await getUserFromToken(token); // Retorna o UUID string do Auth
    if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const reminder_id = searchParams.get('reminder_id');
    if (!reminder_id) return NextResponse.json({ error: 'reminder_id ausente' }, { status: 400 });

    // 1. Busca os relacionamentos ativos diretamente no banco (Schema Jarvis)
    const { data: relationships, error: relError } = await supabase
      .from('relationships')
      .select('user_id_a, user_id_b, settings, contact_name')
      .eq('status', 'active')
      .or(`user_id_a.eq.${authUserId},user_id_b.eq.${authUserId}`);

    if (relError) throw relError;
    if (!relationships || relationships.length === 0) {
      return NextResponse.json({ ok: true, options: [] });
    }

    // Filtra parceiros com sincronização de lembretes ou agenda ativa
    const activePartners = relationships.filter(rel => {
      const settings = rel.settings || {};
      return settings.reminders === true || settings.reminder === true || settings.agenda_enabled === true;
    });

    if (activePartners.length === 0) {
      return NextResponse.json({ ok: true, options: [] });
    }

    const partnerUUIDs = activePartners.map(rel => 
      rel.user_id_a === authUserId ? rel.user_id_b : rel.user_id_a
    );

    // Busca os IDs numéricos (bigint) correspondentes aos UUIDs dos parceiros
    const { data: partnerUsers, error: usersError } = await supabase
      .from('users')
      .select('id, auth_user_id, nickname')
      .in('auth_user_id', partnerUUIDs);

    if (usersError) throw usersError;
    if (!partnerUsers || partnerUsers.length === 0) {
      return NextResponse.json({ ok: true, options: [] });
    }

    const partnerBigintIds = partnerUsers.map(u => u.id);

    // 2. Coleta os compartilhamentos que já estão ativos para este lembrete
    const { data: shares, error: sharesError } = await supabase
      .from('reminder_shares')
      .select('shared_with_id')
      .eq('reminder_id', reminder_id)
      .eq('active', true)
      .in('shared_with_id', partnerBigintIds);

    if (sharesError) throw sharesError;

    const activeIds = new Set(shares?.map(s => String(s.shared_with_id)));

    // 3. Monta o payload mapeando de forma segura
    const options = partnerUsers.map(u => {
      const relDoc = activePartners.find(rel => rel.user_id_a === u.auth_user_id || rel.user_id_b === u.auth_user_id);
      return {
        user_id: u.auth_user_id,
        bigint_id: u.id,
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
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const authUserId = await getUserFromToken(token); // Retorna UUID string
  if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const { reminder_id, shared_with_id, active } = await req.json();

    if (!reminder_id || !shared_with_id || typeof active !== 'boolean') {
      return NextResponse.json(
        { error: 'reminder_id, shared_with_id e active são obrigatórios' },
        { status: 400 }
      );
    }

    // ✅ CORREÇÃO DE TIPO: Resolve o ID numérico (bigint) do criador logado
    const { data: currentUser, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    if (userError || !currentUser) {
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });
    }

    // Confirma posse comparando bigint (banco) com bigint (resolvido)
    const { data: reminder } = await supabase
      .from('reminders')
      .select('user_id')
      .eq('id', reminder_id)
      .maybeSingle();

    if (!reminder || reminder.user_id !== currentUser.id) {
      return NextResponse.json({ error: 'Lembrete não encontrado ou permissão negada' }, { status: 404 });
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
    console.error('[Reminder Shares POST] Erro crítico:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
