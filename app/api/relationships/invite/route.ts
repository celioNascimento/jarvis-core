import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

// ============================================================
// /api/relationships/invite
// POST → cria convite (vínculo pendente) por email ou telefone
//
// user_id_a / user_id_b são TEXT e guardam o auth_user_id (UUID)
// getUserFromToken retorna o id BIGINT — precisamos do auth UUID
// separadamente via supabase.auth.getUser()
// ============================================================

function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

export async function POST(req: Request) {
  const token = extractToken(req);
  if (!token) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  // Precisamos do auth UUID (para gravar em relationships)
  // e do id numérico (para verificar duplicatas via jarvis.users se necessário)
  const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authUser) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const authUUID = authUser.id; // UUID do Supabase Auth — vai para user_id_a

  try {
    const { contact, contactType, relationshipType } = await req.json();

    if (!contact || !contactType || !relationshipType) {
      return NextResponse.json(
        { error: 'contact, contactType e relationshipType são obrigatórios' },
        { status: 400 }
      );
    }

    // Impede auto-convite
    if (contact.trim() === authUUID) {
      return NextResponse.json({ error: 'Você não pode se convidar.' }, { status: 400 });
    }

    // Resolve o usuário alvo pelo email ou telefone
    const lookupField = contactType === 'email' ? 'email' : 'whatsapp';
    const { data: targetUser } = await supabase
      .from('users')
      .select('id, auth_user_id, name, preferred_name')
      .eq(lookupField, contact.trim())
      .maybeSingle();

    // user_id_b: se encontrou na plataforma usa o auth_user_id (UUID),
    // se não encontrou (externo) usa o contato como texto
    const userIdB    = targetUser?.auth_user_id ?? contact.trim();
    const isExternal = !targetUser;

    // Verifica duplicata
    const { data: existing } = await supabase
      .from('relationships')
      .select('id, status')
      .or(
        `and(user_id_a.eq.${authUUID},user_id_b.eq.${userIdB}),` +
        `and(user_id_a.eq.${userIdB},user_id_b.eq.${authUUID})`
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
        user_id_a:         authUUID,
        user_id_b:         userIdB,
        relationship_type: relationshipType,
        type_a:            relationshipType,
        type_b:            relationshipType,
        // externo vai direto como ativo; interno fica pendente até aceitar
        status:            isExternal ? 'active' : 'pending',
        initiated_by:      authUUID,
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