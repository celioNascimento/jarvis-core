import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// /api/relationships/permissions
//
// GET    → lista permissões de um vínculo
// POST   → concede uma permissão
// DELETE → revoga uma permissão
// ============================================================

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const relationshipId = searchParams.get('relationshipId');
  const userId = searchParams.get('userId');

  if (!relationshipId || !userId) {
    return NextResponse.json({ error: 'relationshipId e userId obrigatórios' }, { status: 400 });
  }

  try {
    const { data, error } = await supabase
      .from('relationship_permissions')
      .select('*')
      .eq('relationship_id', relationshipId)
      .eq('is_active', true);

    if (error) throw error;

    // Separa o que EU concedi e o que recebi
    const uid = parseInt(userId);
    const granted  = data?.filter(p => p.granted_by === uid) || [];
    const received = data?.filter(p => p.granted_to === uid) || [];

    return NextResponse.json({ ok: true, granted, received });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}


export async function POST(req: Request) {
  try {
    const { relationshipId, grantedBy, grantedTo, permission } = await req.json();

    // Verifica se o usuário faz parte do vínculo
    const { data: rel } = await supabase
      .from('relationships')
      .select('user_id_a, user_id_b, status')
      .eq('id', relationshipId)
      .single();

    if (!rel || rel.status !== 'active') {
      return NextResponse.json({ error: 'Vínculo não encontrado ou inativo' }, { status: 404 });
    }

    if (rel.user_id_a !== grantedBy && rel.user_id_b !== grantedBy) {
      return NextResponse.json({ error: 'Usuário não pertence a esse vínculo' }, { status: 403 });
    }

    const { data, error } = await supabase
      .from('relationship_permissions')
      .upsert({
        relationship_id: relationshipId,
        granted_by: grantedBy,
        granted_to: grantedTo,
        permission,
        is_active: true,
        granted_at: new Date().toISOString()
      }, { onConflict: 'relationship_id,granted_by,permission' })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, permission: data });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}


export async function DELETE(req: Request) {
  try {
    const { relationshipId, grantedBy, permission } = await req.json();

    const { error } = await supabase
      .from('relationship_permissions')
      .update({ is_active: false })
      .eq('relationship_id', relationshipId)
      .eq('granted_by', grantedBy)
      .eq('permission', permission);

    if (error) throw error;

    return NextResponse.json({ ok: true, message: `Permissão '${permission}' revogada.` });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
