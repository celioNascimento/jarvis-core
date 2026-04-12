import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ============================================================
// /api/relationships/permissions
//
// GET    → lista permissões ativas + itens ocultos do vínculo
// POST   → concede uma permissão (upsert)
// PATCH  → ativa ou desativa uma permissão existente
// DELETE → revoga permanentemente (is_active = false)
// ============================================================

function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

// ── GET /api/relationships/permissions?relationshipId=xxx ────
//
// Retorna:
//   granted[]  — permissões que EU concedi ao parceiro
//   received[] — permissões que o parceiro me concedeu
//   hidden[]   — itens que EU ocultei (relationship_privacy_choices)
export async function GET(req: Request) {
  const token = extractToken(req);
  const userId = await getUserFromToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const relationshipId = searchParams.get('relationshipId');

  if (!relationshipId) {
    return NextResponse.json({ error: 'relationshipId obrigatório' }, { status: 400 });
  }

  // Confirma que o usuário pertence ao vínculo
  const { data: rel, error: relError } = await supabase
    .from('relationships')
    .select('user_id_a, user_id_b, status')
    .eq('id', relationshipId)
    .single();

  if (relError || !rel) {
    return NextResponse.json({ error: 'Vínculo não encontrado' }, { status: 404 });
  }

  const authUserIdStr = String(userId);
  if (rel.user_id_a !== authUserIdStr && rel.user_id_b !== authUserIdStr) {
    return NextResponse.json({ error: 'Acesso negado' }, { status: 403 });
  }

  try {
    // Permissões do vínculo
    const { data: permissions, error: permError } = await supabase
      .from('relationship_permissions')
      .select('id, granted_by, granted_to, permission, is_active, granted_at')
      .eq('relationship_id', relationshipId);

    if (permError) throw permError;

    const granted  = permissions?.filter(p => p.granted_by === authUserIdStr) ?? [];
    const received = permissions?.filter(p => p.granted_to === authUserIdStr) ?? [];

    // Itens ocultos que EU escolhi esconder
    const { data: hidden, error: hiddenError } = await supabase
      .from('relationship_privacy_choices')
      .select('id, resource, hidden_item_id, created_at')
      .eq('relationship_id', relationshipId)
      .eq('owner_id', authUserIdStr);

    // Tabela pode não existir ainda — ignora erro de schema
    const hiddenList = hiddenError ? [] : (hidden ?? []);

    return NextResponse.json({
      ok: true,
      granted,
      received,
      hidden: hiddenList,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── POST /api/relationships/permissions ──────────────────────
//
// Body: { relationshipId, grantedTo, permission }
// O "grantedBy" é sempre o usuário autenticado.
export async function POST(req: Request) {
  const token = extractToken(req);
  const userId = await getUserFromToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const { relationshipId, grantedTo, permission } = await req.json();

    if (!relationshipId || !grantedTo || !permission) {
      return NextResponse.json(
        { error: 'relationshipId, grantedTo e permission são obrigatórios' },
        { status: 400 }
      );
    }

    const grantedBy = String(userId);

    // Verifica que ambos pertencem ao vínculo ativo
    const { data: rel } = await supabase
      .from('relationships')
      .select('user_id_a, user_id_b, status')
      .eq('id', relationshipId)
      .single();

    if (!rel || rel.status !== 'active') {
      return NextResponse.json({ error: 'Vínculo não encontrado ou inativo' }, { status: 404 });
    }

    if (rel.user_id_a !== grantedBy && rel.user_id_b !== grantedBy) {
      return NextResponse.json({ error: 'Você não pertence a esse vínculo' }, { status: 403 });
    }

    if (rel.user_id_a !== grantedTo && rel.user_id_b !== grantedTo) {
      return NextResponse.json({ error: 'Destinatário não pertence a esse vínculo' }, { status: 403 });
    }

    const { data, error } = await supabase
      .from('relationship_permissions')
      .upsert(
        {
          relationship_id: relationshipId,
          granted_by: grantedBy,
          granted_to: grantedTo,
          permission,
          is_active: true,
          granted_at: new Date().toISOString(),
        },
        { onConflict: 'relationship_id,granted_by,permission' }
      )
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, permission: data }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── PATCH /api/relationships/permissions ─────────────────────
//
// Ativa ou desativa uma permissão existente.
// Body: { relationshipId, permission, isActive }
export async function PATCH(req: Request) {
  const token = extractToken(req);
  const userId = await getUserFromToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const { relationshipId, permission, isActive } = await req.json();

    if (!relationshipId || !permission || typeof isActive !== 'boolean') {
      return NextResponse.json(
        { error: 'relationshipId, permission e isActive (boolean) são obrigatórios' },
        { status: 400 }
      );
    }

    const grantedBy = String(userId);

    const { data, error } = await supabase
      .from('relationship_permissions')
      .update({ is_active: isActive })
      .eq('relationship_id', relationshipId)
      .eq('granted_by', grantedBy)
      .eq('permission', permission)
      .select()
      .single();

    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: 'Permissão não encontrada' }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      permission: data,
      message: `Permissão '${permission}' ${isActive ? 'ativada' : 'desativada'}.`,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── DELETE /api/relationships/permissions ────────────────────
//
// Body: { relationshipId, permission }
// Só o próprio concedente pode revogar.
export async function DELETE(req: Request) {
  const token = extractToken(req);
  const userId = await getUserFromToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const { relationshipId, permission } = await req.json();

    if (!relationshipId || !permission) {
      return NextResponse.json(
        { error: 'relationshipId e permission são obrigatórios' },
        { status: 400 }
      );
    }

    const grantedBy = String(userId);

    const { error } = await supabase
      .from('relationship_permissions')
      .update({ is_active: false })
      .eq('relationship_id', relationshipId)
      .eq('granted_by', grantedBy)
      .eq('permission', permission);

    if (error) throw error;

    return NextResponse.json({
      ok: true,
      message: `Permissão '${permission}' revogada.`,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}