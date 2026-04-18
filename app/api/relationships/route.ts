import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ============================================================
// /api/relationships
//
// GET    → lista todos os vínculos do usuário autenticado
// POST   → cria um novo vínculo (convite pendente)
// PATCH  → atualiza status (accept / reject / cancel)
// ============================================================

function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

// ── GET /api/relationships ───────────────────────────────────
// Retorna todos os vínculos onde o usuário é user_id_a ou user_id_b
// Query params opcionais:
//   ?status=active   → filtra por status
export async function GET(req: Request) {
  const token = extractToken(req);
  const userId = await getUserFromToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const statusFilter = searchParams.get('status'); // opcional

  try {
    const authUserIdStr = String(userId);

    // Busca vínculos onde o usuário é parte A ou parte B
    const { data: asA, error: errA } = await supabase
      .from('relationships')
      .select('id, user_id_a, user_id_b, relationship_type, contact_name, status, type_a, type_b, initiated_by, created_at')
      .eq('user_id_a', authUserIdStr)
      .order('created_at', { ascending: false });

    if (errA) throw errA;

    const { data: asB, error: errB } = await supabase
      .from('relationships')
      .select('id, user_id_a, user_id_b, relationship_type, contact_name, status, type_a, type_b, initiated_by, created_at')
      .eq('user_id_b', authUserIdStr)
      .order('created_at', { ascending: false });

    if (errB) throw errB;

    // Junta e deduplica por id
    const all = [...(asA ?? []), ...(asB ?? [])];
    const seen = new Set<string>();
    let unique = all.filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });

    // Filtra por status se pedido
    if (statusFilter) {
      unique = unique.filter(r => r.status === statusFilter);
    }

    // Para vínculos com outro usuário da plataforma, tenta resolver o nome
    // a partir do jarvis.users (melhor UX do que mostrar só contact_name)
    const enriched = await Promise.all(
      unique.map(async rel => {
        const partnerId = rel.user_id_a === authUserIdStr ? rel.user_id_b : rel.user_id_a;

        // Só busca se parece UUID (usuário interno)
        const isUuid = /^[0-9a-f-]{36}$/i.test(partnerId);
        if (!isUuid) return rel;

        const { data: partner } = await supabase
          .from('users')
          .select('preferred_name, full_name, nickname, name')
          .eq('auth_user_id', partnerId)
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

// ── POST /api/relationships ──────────────────────────────────
// Cria um vínculo pendente (convite)
// Body: { contact, contactType: 'email'|'phone', relationshipType }
export async function POST(req: Request) {
  const token = extractToken(req);
  const userId = await getUserFromToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const { contact, contactType, relationshipType } = await req.json();

    if (!contact || !contactType || !relationshipType) {
      return NextResponse.json(
        { error: 'contact, contactType e relationshipType são obrigatórios' },
        { status: 400 }
      );
    }

    const authUserIdStr = String(userId);

    // Tenta encontrar o usuário pelo email ou telefone
    const lookupField = contactType === 'email' ? 'email' : 'whatsapp';
    const { data: targetUser } = await supabase
      .from('users')
      .select('id, auth_user_id, name, preferred_name')
      .eq(lookupField, contact.trim())
      .maybeSingle();

    // Se achou o usuário na plataforma, cria vínculo direto
    // Se não achou, cria como contato externo (is_external = true)
    const userIdB    = targetUser?.auth_user_id ?? contact.trim();
    const isExternal = !targetUser;

    // Verifica se já existe vínculo entre os dois
    const { data: existing } = await supabase
      .from('relationships')
      .select('id, status')
      .or(
        `and(user_id_a.eq.${authUserIdStr},user_id_b.eq.${userIdB}),` +
        `and(user_id_a.eq.${userIdB},user_id_b.eq.${authUserIdStr})`
      )
      .maybeSingle();

    if (existing) {
      if (existing.status === 'active') {
        return NextResponse.json({ error: 'Já existe um vínculo ativo com essa pessoa.' }, { status: 409 });
      }
      if (existing.status === 'pending') {
        return NextResponse.json({ error: 'Já existe um convite pendente com essa pessoa.' }, { status: 409 });
      }
    }

    const { data: rel, error } = await supabase
      .from('relationships')
      .insert({
        user_id_a:         authUserIdStr,
        user_id_b:         userIdB,
        relationship_type: relationshipType,
        type_a:            relationshipType,
        type_b:            relationshipType,
        status:            isExternal ? 'active' : 'pending',
        initiated_by:      authUserIdStr,
        is_external:       isExternal,
        contact_name:      isExternal ? contact.trim() : (targetUser?.preferred_name ?? targetUser?.name ?? null),
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, relationship: rel }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── PATCH /api/relationships ─────────────────────────────────
// Atualiza status de um vínculo
// Body: { relationshipId, action: 'accept'|'reject'|'cancel'|'end' }
export async function PATCH(req: Request) {
  const token = extractToken(req);
  const userId = await getUserFromToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const { relationshipId, action } = await req.json();

    if (!relationshipId || !action) {
      return NextResponse.json(
        { error: 'relationshipId e action são obrigatórios' },
        { status: 400 }
      );
    }

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

    const statusMap: Record<string, string> = {
      accept: 'active',
      reject: 'ended',
      cancel: 'ended',
      end:    'ended',
    };

    const newStatus = statusMap[action];
    if (!newStatus) {
      return NextResponse.json({ error: `action inválida: ${action}` }, { status: 400 });
    }

    // Só o destinatário pode aceitar/rejeitar — quem enviou só pode cancelar
    if (action === 'accept' || action === 'reject') {
      if (rel.initiated_by === authUserIdStr) {
        return NextResponse.json(
          { error: 'Quem enviou o convite não pode aceitá-lo ou rejeitá-lo.' },
          { status: 403 }
        );
      }
    }

    const { data: updated, error } = await supabase
      .from('relationships')
      .update({
        status:       newStatus,
        connected_at: action === 'accept' ? new Date().toISOString() : undefined,
        ended_at:     ['reject','cancel','end'].includes(action) ? new Date().toISOString() : undefined,
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