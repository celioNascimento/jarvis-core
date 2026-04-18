import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// /api/relationships/invite
// POST → cria convite (vínculo pendente) por email ou telefone
//
// - Usuário interno (encontrado no banco): status = 'pending', 
//   contact_name = nome dele, user_id_b = auth_user_id (UUID)
// - Contato externo (não encontrado): status = 'active',
//   contact_name = email/telefone digitado
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

export async function POST(req: Request) {
  const token = extractToken(req);
  const authUUID = await getAuthUUID(token);
  if (!authUUID) {
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

    const contactTrimmed = contact.trim();

    // Tenta encontrar o usuário — email ou telefone (testa ambos os campos)
    let targetUser: { id: number; auth_user_id: string; name: string; preferred_name: string | null; nickname: string | null } | null = null;

    if (contactType === 'email') {
      const { data } = await supabase
        .from('users')
        .select('id, auth_user_id, name, preferred_name, nickname')
        .eq('email', contactTrimmed)
        .maybeSingle();
      targetUser = data;
    } else {
      // Tenta whatsapp primeiro, depois phone
      const { data: byWhatsapp } = await supabase
        .from('users')
        .select('id, auth_user_id, name, preferred_name, nickname')
        .eq('whatsapp', contactTrimmed)
        .maybeSingle();

      if (byWhatsapp) {
        targetUser = byWhatsapp;
      } else {
        const { data: byPhone } = await supabase
          .from('users')
          .select('id, auth_user_id, name, preferred_name, nickname')
          .eq('phone', contactTrimmed)
          .maybeSingle();
        targetUser = byPhone;
      }
    }

    const userIdB    = targetUser?.auth_user_id ?? contactTrimmed;
    const isExternal = !targetUser;

    // Impede auto-convite
    if (userIdB === authUUID) {
      return NextResponse.json({ error: 'Você não pode se convidar.' }, { status: 400 });
    }

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

    // Nome a exibir: preferido > nickname > nome > contato digitado
    const resolvedName = isExternal
      ? contactTrimmed
      : (targetUser?.preferred_name ?? targetUser?.nickname ?? targetUser?.name ?? contactTrimmed);

    const { data: rel, error } = await supabase
      .from('relationships')
      .insert({
        user_id_a:         authUUID,
        user_id_b:         userIdB,
        relationship_type: relationshipType,
        type_a:            relationshipType,
        type_b:            relationshipType,
        status:            isExternal ? 'active' : 'pending',
        initiated_by:      authUUID,
        is_external:       isExternal,
        contact_name:      resolvedName,
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, relationship: rel }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}