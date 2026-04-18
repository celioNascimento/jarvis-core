import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ============================================================
// /api/relationships/[id]/[action]
//
// POST /api/relationships/:id/accept  → aceita convite pendente
// POST /api/relationships/:id/reject  → recusa ou cancela convite
// ============================================================

function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; action: string }> }
) {
  const token = extractToken(req);
  const userId = await getUserFromToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const { id: relationshipId, action } = await params;

  if (!['accept', 'reject'].includes(action)) {
    return NextResponse.json({ error: `Ação inválida: ${action}` }, { status: 400 });
  }

  try {
    const authUserIdStr = String(userId);

    const { data: rel } = await supabase
      .from('relationships')
      .select('id, user_id_a, user_id_b, status, initiated_by')
      .eq('id', relationshipId)
      .single();

    if (!rel) {
      return NextResponse.json({ error: 'Vínculo não encontrado' }, { status: 404 });
    }

    if (rel.user_id_a !== authUserIdStr && rel.user_id_b !== authUserIdStr) {
      return NextResponse.json({ error: 'Acesso negado' }, { status: 403 });
    }

    if (rel.status !== 'pending') {
      return NextResponse.json({ error: 'Vínculo não está pendente' }, { status: 409 });
    }

    // Accept: só quem recebeu o convite (não quem iniciou)
    // Reject/cancel: qualquer um dos dois pode
    if (action === 'accept' && rel.initiated_by === authUserIdStr) {
      return NextResponse.json(
        { error: 'Quem enviou o convite não pode aceitá-lo.' },
        { status: 403 }
      );
    }

    const isAccept = action === 'accept';

    const { data: updated, error } = await supabase
      .from('relationships')
      .update({
        status:       isAccept ? 'active' : 'ended',
        connected_at: isAccept ? new Date().toISOString() : null,
        ended_at:     !isAccept ? new Date().toISOString() : null,
      })
      .eq('id', relationshipId)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, relationship: updated });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}