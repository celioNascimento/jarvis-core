// app/api/shopping/shares/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ── GET /api/shopping/shares?category=mercado ─────────────────────────────────
// Retorna a lista de vínculos que têm shopping_enabled=true,
// indicando quais já têm compartilhamento ativo nessa categoria.
export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const category = searchParams.get('category');
  if (!category) return NextResponse.json({ error: 'category obrigatório' }, { status: 400 });

  const { data: userRow } = await supabase
    .schema('jarvis')
    .from('users')
    .select('auth_user_id')
    .eq('id', userId)
    .maybeSingle();

  if (!userRow) return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });

  const { data: relationships } = await supabase
    .schema('jarvis')
    .from('relationships')
    .select('id, user_id_a, user_id_b, contact_name, settings')
    .eq('status', 'active')
    .or(`user_id_a.eq.${userRow.auth_user_id},user_id_b.eq.${userRow.auth_user_id}`);

  const shoppingRelationships = (relationships ?? []).filter(
    r => r.settings?.shopping_enabled === true
  );

  // ── LOG 1 ──────────────────────────────────────────────────────────────────
  console.log('[DEBUG settings raw]', JSON.stringify(relationships, null, 2));
  console.log('[DEBUG shoppingFiltered]', JSON.stringify(shoppingRelationships, null, 2));
  // ──────────────────────────────────────────────────────────────────────────

  if (shoppingRelationships.length === 0) {
    return NextResponse.json({ ok: true, options: [] });
  }

  const partnerUUIDs = shoppingRelationships.map(r =>
    r.user_id_a === userRow.auth_user_id ? r.user_id_b : r.user_id_a
  );

  const { data: partners } = await supabase
    .from('users')
    .select('id, auth_user_id, preferred_name, nickname, name')
    .in('auth_user_id', partnerUUIDs);

  // ── LOG 2 ──────────────────────────────────────────────────────────────────
  console.log('[DEBUG partners]', JSON.stringify({
    partnerUUIDs,
    partners,
  }, null, 2));
  // ──────────────────────────────────────────────────────────────────────────

  const partnerBigintIds = (partners ?? []).map(p => p.id);
  const { data: existingShares } = await supabase
    .from('shopping_shares')
    .select('shared_with_id')
    .eq('owner_id', userId)
    .eq('category', category)
    .in('shared_with_id', partnerBigintIds);

  const activeShareIds = new Set((existingShares ?? []).map(s => s.shared_with_id));

  const options = shoppingRelationships.map(rel => {
    const partnerUUID = rel.user_id_a === userRow.auth_user_id ? rel.user_id_b : rel.user_id_a;
    const partner = (partners ?? []).find(p => p.auth_user_id === partnerUUID);
    if (!partner) return null;

    const contactName =
      partner.preferred_name ||
      partner.nickname ||
      partner.name ||
      rel.contact_name ||
      'Contato';

    return {
      user_id: partner.auth_user_id,
      bigint_id: partner.id,
      contact_name: contactName,
      is_active: activeShareIds.has(partner.id),
    };
  }).filter(Boolean);

  // ── LOG 3 ──────────────────────────────────────────────────────────────────
  console.log('[DEBUG final options]', JSON.stringify({
    partnerBigintIds,
    existingShares,
    activeShareIds: [...activeShareIds],
    options,
  }, null, 2));
  // ──────────────────────────────────────────────────────────────────────────

  return NextResponse.json({ ok: true, options });
}

// ── POST /api/shopping/shares ─────────────────────────────────────────────────
// Liga ou desliga o compartilhamento de uma categoria com uma pessoa.
export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { category, shared_with_id, active } = await req.json();

  if (!category || !shared_with_id || typeof active !== 'boolean') {
    return NextResponse.json({ error: 'category, shared_with_id e active são obrigatórios' }, { status: 400 });
  }

  if (active) {
    // Upsert — cria ou mantém o compartilhamento
    const { error } = await supabase
      .from('shopping_shares')
      .upsert(
        { owner_id: userId, shared_with_id, category },
        { onConflict: 'owner_id,shared_with_id,category' }
      );

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    // Remove o compartilhamento
    const { error } = await supabase
      .from('shopping_shares')
      .delete()
      .eq('owner_id', userId)
      .eq('shared_with_id', shared_with_id)
      .eq('category', category);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}