import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ============================================================
// /api/relationships/invite
//
// POST → cria um convite (vínculo pendente) por email ou telefone
//        Atalho semântico para POST /api/relationships
// ============================================================

function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

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

    // Resolve o usuário pelo email ou telefone (campo whatsapp/phone)
    const lookupField = contactType === 'email' ? 'email' : 'whatsapp';
    const { data: targetUser } = await supabase
      .from('users')
      .select('id, auth_user_id, name, preferred_name')
      .eq(lookupField, contact.trim())
      .maybeSingle();

    const userIdB    = targetUser?.auth_user_id ?? contact.trim();
    const isExternal = !targetUser;

    // Impede auto-convite
    if (userIdB === authUserIdStr) {
      return NextResponse.json({ error: 'Você não pode se convidar.' }, { status: 400 });
    }

    // Verifica duplicata
    const { data: existing } = await supabase
      .from('relationships')
      .select('id, status')
      .or(
        `and(user_id_a.eq.${authUserIdStr},user_id_b.eq.${userIdB}),` +
        `and(user_id_a.eq.${userIdB},user_id_b.eq.${authUserIdStr})`
      )
      .maybeSingle();

    if (existing?.status === 'active') {
      return NextResponse.json({ error: 'Já existe um vínculo ativo com essa pessoa.' }, { status: 409 });
    }
    if (existing?.status === 'pending') {
      return NextResponse.json({ error: 'Já existe um convite pendente com essa pessoa.' }, { status: 409 });
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
        contact_name:      isExternal
          ? contact.trim()
          : (targetUser?.preferred_name ?? targetUser?.name ?? null),
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, relationship: rel }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}