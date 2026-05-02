import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// /api/relationships
// GET → lista vínculos do usuário, sempre com nome resolvido
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

// ── GET /api/relationships ───────────────────────────────────
export async function GET(req: Request) {
  const token = extractToken(req);
  const authUUID = await getAuthUUID(token);
  if (!authUUID) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const { data: asA, error: errA } = await supabase
      .from('relationships')
      .select('id, user_id_a, user_id_b, relationship_type, contact_name, status, type_a, type_b, initiated_by, created_at, settings')
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

    // Enriquece o nome do parceiro para vínculos internos (não externos)
    // Sempre tenta resolver pelo auth_user_id para ter o nome mais atualizado
    const enriched = await Promise.all(
      unique.map(async rel => {
        const partnerUUID = rel.user_id_a === authUUID ? rel.user_id_b : rel.user_id_a;

        // Só busca se parece UUID (usuário interno da plataforma)
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(partnerUUID);
        if (!isUUID) return rel; // externo — mantém contact_name como está (email/telefone)

        const { data: partner } = await supabase
          .from('users')
          .select('preferred_name, full_name, nickname, name')
          .eq('auth_user_id', partnerUUID)
          .maybeSingle();

        if (!partner) return rel;

        const resolvedName =
          partner.preferred_name ||
          partner.nickname ||
          partner.full_name ||
          partner.name ||
          rel.contact_name;

        return { ...rel, contact_name: resolvedName };
      })
    );

    return NextResponse.json({ ok: true, relationships: enriched });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}