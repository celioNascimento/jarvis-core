// app/api/reminders/shares/route.ts
// Motor V1.2.0 — Alinhamento de Autenticação BigInt (Padrão Calendar Engine)

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ── Helper de Extração de ID Numérico (Idêntico ao do Calendar Engine) ───────
async function getUserIdFromReq(req: NextRequest): Promise<number | null> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await supabase.auth.getUser(token);
  if (!data?.user) return null;
  const { data: profile } = await supabase
    .from('users')
    .select('id')
    .eq('auth_user_id', data.user.id)
    .single();
  return profile?.id || null;
}

// ── GET OPTIONS ──────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const userId = await getUserIdFromReq(req); // Retorna o ID numérico (BigInt) correto
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const { searchParams } = new URL(req.url);
    const reminder_id = searchParams.get('reminder_id');
    if (!reminder_id) return NextResponse.json({ error: 'reminder_id ausente' }, { status: 400 });

    // 1. Busca os relacionamentos ativos comparando Número com Número (Zero conflitos)
    const { data: relationships, error: relError } = await supabase
      .from('relationships')
      .select('user_id_a, user_id_b, settings, contact_name')
      .eq('status', 'active')
      .or(`user_id_a.eq.${userId},user_id_b.eq.${userId}`);

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

    const partnerIds = activePartners.map(rel => 
      rel.user_id_a === userId ? rel.user_id_b : rel.user_id_a
    );

    // Busca os dados cadastrais dos parceiros pelos IDs numéricos obtidos
    const { data: partnerUsers, error: usersError } = await supabase
      .from('users')
      .select('id, auth_user_id, nickname')
      .in('id', partnerIds);

    if (usersError) throw usersError;
    if (!partnerUsers || partnerUsers.length === 0) {
      return NextResponse.json({ ok: true, options: [] });
    }

    // 2. Coleta quais compartilhamentos já estão ativos para este lembrete específico
    const { data: shares, error: sharesError } = await supabase
      .from('reminder_shares')
      .select('shared_with_id')
      .eq('reminder_id', reminder_id)
      .eq('active', true)
      .in('shared_with_id', partnerIds);

    if (sharesError) throw sharesError;

    const activeIds = new Set(shares?.map(s => String(s.shared_with_id)));

    // 3. Monta o payload mapeando de forma segura para o front-end
    const options = partnerUsers.map(u => {
      const relDoc = activePartners.find(rel => rel.user_id_a === u.id || rel.user_id_b === u.id);
      return {
        user_id: u.auth_user_id,       // UUID string esperado pelo componente visual do App
        bigint_id: u.id,               // ID numérico para queries internas do banco
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

// ── POST MUTATION ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const userId = await getUserIdFromReq(req); // Retorna BigInt
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const { reminder_id, shared_with_id, active } = await req.json();

    if (!reminder_id || !shared_with_id || typeof active !== 'boolean') {
      return NextResponse.json(
        { error: 'reminder_id, shared_with_id e active são obrigatórios' },
        { status: 400 }
      );
    }

    // Confirma posse comparando BigInt (banco) com BigInt (usuário logado)
    const { data: reminder, error: remError } = await supabase
      .from('reminders')
      .select('user_id')
      .eq('id', reminder_id)
      .maybeSingle();

    if (remError || !reminder || reminder.user_id !== userId) {
      return NextResponse.json({ error: 'Lembrete não encontrado ou permissão negada' }, { status: 404 });
    }

    // Realiza a persistência do vínculo compartilhado
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
