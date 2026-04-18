import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// /api/relationships
//
// user_id_a / user_id_b são TEXT e guardam o auth_user_id (UUID)
// Usamos supabase.auth.getUser() diretamente para obter o UUID
//
// GET  → lista todos os vínculos do usuário
// POST → cria vínculo (use /invite para convites por email/telefone)
// ============================================================

function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

// ── GET /api/relationships ───────────────────────────────────
export async function GET(req: Request) {
  const token = extractToken(req);
  if (!token) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authUser) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const authUUID = authUser.id;

  try {
    const { data: asA, error: errA } = await supabase
      .from('relationships')
      .select('id, user_id_a, user_id_b, relationship_type, contact_name, status, type_a, type_b, initiated_by, created_at')
      .eq('user_id_a', authUUID)
      .order('created_at', { ascending: false });

    if (errA) throw errA;

    const { data: asB, error: errB } = await supabase
      .from('relationships')
      .select('id, user_id_a, user_id_b, relationship_type, contact_name, status, type_a, type_b, initiated_by, created_at')
      .eq('user_id_b', authUUID)
      .order('created_at', { ascending: false });

    if (errB) throw errB;

    // Junta e deduplica
    const all = [...(asA ?? []), ...(asB ?? [])];
    const seen = new Set<string>();
    const unique = all.filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });

    // Resolve nome do parceiro quando é usuário interno
    const enriched = await Promise.all(
      unique.map(async rel => {
        const partnerUUID = rel.user_id_a === authUUID ? rel.user_id_b : rel.user_id_a;
        const isUuid = /^[0-9a-f-]{36}$/i.test(partnerUUID);
        if (!isUuid) return rel;

        const { data: partner } = await supabase
          .from('users')
          .select('preferred_name, full_name, nickname, name')
          .eq('auth_user_id', partnerUUID)
          .maybeSingle();

        if (!partner) return rel;

        return {
          ...rel,
          contact_name:
            partner.preferred_name ||
            partner.nickname ||
            partner.full_name ||
            partner.name ||
            rel.contact_name,
        };
      })
    );

    return NextResponse.json({ ok: true, relationships: enriched });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}