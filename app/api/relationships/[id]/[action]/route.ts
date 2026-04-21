import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// /api/relationships/[id]/[action]
// POST /api/relationships/:id/accept  → aceita convite
// POST /api/relationships/:id/reject  → recusa ou cancela
// ============================================================

function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

async function getAuthUUID(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; action: string }> }
) {
  const token = extractToken(req);
  const authUUID = await getAuthUUID(token);
  if (!authUUID) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const { id: relationshipId, action } = await params;

  if (!['accept', 'reject'].includes(action)) {
    return NextResponse.json({ error: `Ação inválida: ${action}` }, { status: 400 });
  }

  try {
    const { data: rel } = await supabase
      .schema('jarvis')
      .from('relationships')
      .select('id, user_id_a, user_id_b, status, initiated_by, relationship_type')
      .eq('id', relationshipId)
      .single();

    if (!rel) {
      return NextResponse.json({ error: 'Vínculo não encontrado' }, { status: 404 });
    }

    if (rel.user_id_a !== authUUID && rel.user_id_b !== authUUID) {
      return NextResponse.json({ error: 'Acesso negado' }, { status: 403 });
    }

    if (rel.status !== 'pending') {
      return NextResponse.json({ error: 'Vínculo não está pendente' }, { status: 409 });
    }

    if (action === 'accept' && rel.initiated_by === authUUID) {
      return NextResponse.json(
        { error: 'Quem enviou o convite não pode aceitá-lo.' },
        { status: 403 }
      );
    }

    const isAccept = action === 'accept';

    const { data: updated, error } = await supabase
      .schema('jarvis')
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

    // ── Auto-join família para vínculos familiares (apenas quando aceita) ──
    if (isAccept) {
      const FAMILY_TYPES = ['spouse', 'partner', 'parent', 'child'];
      if (FAMILY_TYPES.includes(rel.relationship_type)) {
        // Busca family_id dos dois pelo auth_uuid → id numérico
        const { data: users } = await supabase
          .schema('jarvis')
          .from('users')
          .select('id, auth_user_id, family_id')
          .in('auth_user_id', [rel.user_id_a, rel.user_id_b]);

        const userA = users?.find(u => u.auth_user_id === rel.user_id_a);
        const userB = users?.find(u => u.auth_user_id === rel.user_id_b);

        if (userA && userB) {
          const aHasFamily = !!userA.family_id;
          const bHasFamily = !!userB.family_id;

          // Helper para validar limite e inserir na família
          const checkAndJoinFamily = async (targetUserId: number, familyId: string) => {
            const { count } = await supabase
              .schema('jarvis')
              .from('users')
              .select('id', { count: 'exact', head: true })
              .eq('family_id', familyId);

            const { data: fam } = await supabase
              .schema('jarvis')
              .from('families')
              .select('plan')
              .eq('id', familyId)
              .single();

            const limits: Record<string, number> = {
              free: 2, personal: 1, family: 6, family_plus: 12,
            };
            const max = limits[fam?.plan ?? 'free'] ?? 2;

            if ((count ?? 0) < max) {
              await supabase
                .schema('jarvis')
                .from('users')
                .update({ family_id: familyId })
                .eq('id', targetUserId);
            }
          };

          if (aHasFamily && !bHasFamily) {
            await checkAndJoinFamily(userB.id, userA.family_id);
          } else if (!aHasFamily && bHasFamily) {
            await checkAndJoinFamily(userA.id, userB.family_id);
          }
        }
      }
    }

    return NextResponse.json({ ok: true, relationship: updated });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}