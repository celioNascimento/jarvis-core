// app/api/reminders/shares/route.ts
// Motor V1.3.0 — Rigor de Escopo de Schema + Ampla Listagem de Vínculos

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ── Helper de Extração de ID Numérico (Alinhado com o Schema Jarvis) ─────────
async function getUserIdFromReq(req: NextRequest): Promise<number | null> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await supabase.auth.getUser(token);
  if (!data?.user) return null;
  
  const { data: profile } = await supabase
    .schema('jarvis') // 🔥 Garante o escopo correto na autenticação
    .from('users')
    .select('id')
    .eq('auth_user_id', data.user.id)
    .single();
    
  return profile?.id || null;
}

// ── GET OPTIONS ──────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const userId = await getUserIdFromReq(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const { searchParams } = new URL(req.url);
    const reminder_id = searchParams.get('reminder_id');
    if (!reminder_id) return NextResponse.json({ error: 'reminder_id ausente' }, { status: 400 });

    // 1. Busca ampla de relacionamentos ativos no schema correto
    const { data: relationships, error: relError } = await supabase
      .schema('jarvis') // 🔥 Encadeamento estrito de schema
      .from('relationships')
      .select('user_id_a, user_id_b, contact_name')
      .eq('status', 'active')
      .or(`user_id_a.eq.${userId},user_id_b.eq.${userId}`);

    if (relError) throw relError;
    if (!relationships || relationships.length === 0) {
      return NextResponse.json({ ok: true, options: [] });
    }

    // Coleta os IDs de todos os parceiros ativos sem restrição de flags de settings
    const partnerIds = relationships.map(rel => 
      rel.user_id_a === userId ? rel.user_id_b : rel.user_id_a
    );

    // Busca os metadados dos parceiros ativos
    const { data: partnerUsers, error: usersError } = await supabase
      .schema('jarvis') // 🔥 Encadeamento estrito de schema
      .from('users')
      .select('id, auth_user_id, nickname')
      .in('id', partnerIds);

    if (usersError) throw usersError;
    if (!partnerUsers || partnerUsers.length === 0) {
      return NextResponse.json({ ok: true, options: [] });
    }

    // 2. Coleta quais compartilhamentos já estão gravados para este lembrete
    const { data: shares, error: sharesError } = await supabase
      .schema('jarvis') // 🔥 Encadeamento estrito de schema
      .from('reminder_shares')
      .select('shared_with_id')
      .eq('reminder_id', reminder_id)
      .eq('active', true)
      .in('shared_with_id', partnerIds);

    if (sharesError) throw sharesError;

    const activeIds = new Set(shares?.map(s => String(s.shared_with_id)));

    // 3. Monta as opções para renderização no App
    const options = partnerUsers.map(u => {
      const relDoc = relationships.find(rel => rel.user_id_a === u.id || rel.user_id_b === u.id);
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

// ── POST MUTATION ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const userId = await getUserIdFromReq(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const { reminder_id, shared_with_id, active } = await req.json();

    if (!reminder_id || !shared_with_id || typeof active !== 'boolean') {
      return NextResponse.json(
        { error: 'reminder_id, shared_with_id e active são obrigatórios' },
        { status: 400 }
      );
    }

    // Confirma posse do lembrete no escopo do schema jarvis
    const { data: reminder, error: remError } = await supabase
      .schema('jarvis') // 🔥 Encadeamento estrito de schema
      .from('reminders')
      .select('user_id')
      .eq('id', reminder_id)
      .maybeSingle();

    if (remError || !reminder || reminder.user_id !== userId) {
      return NextResponse.json({ error: 'Lembrete não encontrado ou permissão negada' }, { status: 404 });
    }

    // Persiste ou atualiza o estado do compartilhamento
    const { error } = await supabase
      .schema('jarvis') // 🔥 Encadeamento estrito de schema
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
