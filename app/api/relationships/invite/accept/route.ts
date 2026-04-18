import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// /api/relationships/invite
//
// POST → cria convite com token único + envia push + retorna link
//
// Retorna:
//   inviteLink  → jarvis://invite/{token}  (deep link direto para o app)
//   pushSent    → boolean indicando se a push foi enviada
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

async function sendPushNotification(
  pushToken: string,
  title: string,
  body: string,
  data?: object,
) {
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: pushToken, title, body, data, sound: 'default' }),
    });
  } catch (e) {
    console.warn('[Push] Falha ao enviar notificação:', e);
  }
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

    // Busca quem está convidando (para nome na notificação)
    const { data: inviter } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id, name, preferred_name, nickname')
      .eq('auth_user_id', authUUID)
      .maybeSingle();

    const inviterName =
      inviter?.preferred_name ?? inviter?.nickname ?? inviter?.name ?? 'Alguém';

    // Tenta encontrar o usuário alvo pelo email
    let targetUser: {
      id: number;
      auth_user_id: string;
      name: string;
      preferred_name: string | null;
      nickname: string | null;
      push_token: string | null;
    } | null = null;

    if (contactType === 'email') {
      const { data } = await supabase
        .schema('jarvis')
        .from('users')
        .select('id, auth_user_id, name, preferred_name, nickname, push_token')
        .eq('email', contactTrimmed)
        .maybeSingle();
      targetUser = data;
    }

    const userIdB    = targetUser?.auth_user_id ?? contactTrimmed;
    const isExternal = !targetUser;

    // Impede auto-convite
    if (userIdB === authUUID) {
      return NextResponse.json({ error: 'Você não pode se convidar.' }, { status: 400 });
    }

    // Verifica duplicata ativa ou pendente
    const { data: existing } = await supabase
      .schema('jarvis')
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

    // Nome a exibir no card de vínculo
    const resolvedName = isExternal
      ? contactTrimmed
      : (targetUser?.preferred_name ?? targetUser?.nickname ?? targetUser?.name ?? contactTrimmed);

    // Cria o vínculo
    const { data: rel, error: relError } = await supabase
      .schema('jarvis')
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

    if (relError) throw relError;

    // Para usuários internos, cria o token de convite na tabela relationship_invites
    if (!isExternal) {
      const { data: invite, error: inviteError } = await supabase
        .schema('jarvis')
        .from('relationship_invites')
        .insert({
          relationship_id: rel.id,
          invited_by:      authUUID,
          invited_email:   contactTrimmed,
        })
        .select('token')
        .single();

      if (inviteError) throw inviteError;

      // Deep link que o app consegue processar via useInviteDeepLink
      const deepLink = `jarvis://invite/${invite.token}`;

      // Envia push se o alvo tem token registrado
      let pushSent = false;
      if (targetUser?.push_token) {
        await sendPushNotification(
          targetUser.push_token,
          '🔗 Novo convite de vínculo',
          `${inviterName} quer se vincular com você no Lev.`,
          {
            screen:   'Vinculos',
            token:    invite.token,
            // deepLink no payload é o que o App.tsx usa ao detectar o tap na notificação
            deepLink,
          }
        );
        pushSent = true;
      }

      return NextResponse.json({
        ok:           true,
        relationship: rel,
        inviteLink:   deepLink,  // retornado ao frontend para exibir/compartilhar
        pushSent,
      }, { status: 201 });
    }

    // Externo — vínculo já ativo, sem token de convite
    return NextResponse.json({ ok: true, relationship: rel }, { status: 201 });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}