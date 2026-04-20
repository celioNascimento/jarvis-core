import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// POST /api/relationships/invite
//
// Aceita duas formas de body:
//
// A) Usuário encontrado pela busca (tem conta):
//    { targetAuthUUID, relationshipType }
//    → cria relationship(pending) + invite token + push
//
// B) Email manual (pode ou não ter conta):
//    { contact, contactType: 'email', relationshipType }
//    → busca por email; se achar, trata como A
//    → se não achar, cria só invite token + envia email
//
// Retorna sempre: { inviteLink, pushSent, newUser?, reused? }
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

async function sendPush(pushToken: string, title: string, body: string, data: object) {
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: pushToken, title, body, data, sound: 'default' }),
    });
  } catch (e) {
    console.warn('[Push] Falha:', e);
  }
}

async function sendInviteEmail(toEmail: string, inviterName: string, inviteLink: string) {
  // Usa o Supabase para enviar email transacional
  // Se você tiver configurado um provider (Resend, Postmark etc.) use aqui
  // Por ora, usa o endpoint de email do Supabase Auth como fallback simples
  try {
    await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/send-invite-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ toEmail, inviterName, inviteLink }),
    });
  } catch (e) {
    console.warn('[Email] Falha ao enviar email de convite:', e);
  }
}

export async function POST(req: Request) {
  const authToken = extractToken(req);
  const authUUID  = await getAuthUUID(authToken);
  if (!authUUID) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { relationshipType, targetAuthUUID, contact, contactType } = body;

    if (!relationshipType) {
      return NextResponse.json({ error: 'relationshipType é obrigatório' }, { status: 400 });
    }
    if (!targetAuthUUID && !contact) {
      return NextResponse.json({ error: 'Informe targetAuthUUID ou contact' }, { status: 400 });
    }

    // ── 1. Quem está convidando ──────────────────────────────
    const { data: inviter } = await supabase
      .from('users')
      .select('id, name, preferred_name, nickname')
      .eq('auth_user_id', authUUID)
      .maybeSingle();

    if (!inviter) {
      return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 });
    }

    const inviterName = inviter.preferred_name ?? inviter.nickname ?? inviter.name ?? 'Alguém';

    // ── 2. Resolve o usuário alvo ────────────────────────────
    let targetUser: {
      auth_user_id: string;
      name: string;
      preferred_name: string | null;
      nickname: string | null;
      push_token: string | null;
      email: string | null;
    } | null = null;

    let contactEmail: string | null = null;

    if (targetAuthUUID) {
      // Veio da busca — busca direto pelo UUID
      const { data } = await supabase
        .schema('jarvis')
        .from('users')
        .select('auth_user_id, name, preferred_name, nickname, push_token, email')
        .eq('auth_user_id', targetAuthUUID)
        .maybeSingle();
      targetUser = data;
      contactEmail = data?.email ?? null;
    } else if (contact && contactType === 'email') {
      // Veio do input manual de email
      contactEmail = contact.trim().toLowerCase();
      const { data } = await supabase
        .schema('jarvis')
        .from('users')
        .select('auth_user_id, name, preferred_name, nickname, push_token, email')
        .eq('email', contactEmail)
        .maybeSingle();
      targetUser = data;
    }

    // Impede auto-convite
    if (targetUser?.auth_user_id === authUUID) {
      return NextResponse.json({ error: 'Você não pode se convidar.' }, { status: 400 });
    }

    // ── 3. Verifica convite pendente já existente ────────────
    // Busca por auth_uuid (usuário com conta) ou por email (sem conta)
    const inviteQuery = supabase
      .schema('jarvis')
      .from('relationship_invites')
      .select('id, token, accepted_at, expires_at')
      .eq('invited_by', authUUID)
      .is('accepted_at', null);

    const { data: existingInvite } = targetUser
      ? await inviteQuery.eq('invited_user_id', targetUser.auth_user_id).maybeSingle()
      : await inviteQuery.eq('invited_email', contactEmail ?? '').maybeSingle();

    if (existingInvite) {
      if (new Date(existingInvite.expires_at) > new Date()) {
        const deepLink = `jarvis://invite/${existingInvite.token}`;
        return NextResponse.json({
          ok:         true,
          inviteLink: deepLink,
          pushSent:   false,
          reused:     true,
          message:    'Convite já enviado. Compartilhe o link abaixo.',
        });
      }
      // Expirado — deleta para criar novo
      await supabase
        .schema('jarvis')
        .from('relationship_invites')
        .delete()
        .eq('id', existingInvite.id);
    }

    // ── 4a. Convidado TEM conta ──────────────────────────────
    if (targetUser) {
      // Verifica vínculo duplicado
      const { data: existing } = await supabase
        .schema('jarvis')
        .from('relationships')
        .select('id, status')
        .or(
          `and(user_id_a.eq.${authUUID},user_id_b.eq.${targetUser.auth_user_id}),` +
          `and(user_id_a.eq.${targetUser.auth_user_id},user_id_b.eq.${authUUID})`
        )
        .in('status', ['active', 'pending'])
        .maybeSingle();

      if (existing?.status === 'active') {
        return NextResponse.json({ error: 'Já existe um vínculo ativo com essa pessoa.' }, { status: 409 });
      }
      if (existing?.status === 'pending') {
        return NextResponse.json({ error: 'Já existe um convite pendente com essa pessoa.' }, { status: 409 });
      }

      const targetName =
        targetUser.preferred_name ?? targetUser.nickname ?? targetUser.name ?? contactEmail ?? 'Contato';

      // Cria relationship pending
      const { data: rel, error: relError } = await supabase
        .schema('jarvis')
        .from('relationships')
        .insert({
          user_id_a:         authUUID,
          user_id_b:         targetUser.auth_user_id,
          relationship_type: relationshipType,
          type_a:            relationshipType,
          type_b:            relationshipType,
          status:            'pending',
          initiated_by:      authUUID,
          is_external:       false,
          contact_name:      targetName,
        })
        .select('id')
        .single();

      if (relError) throw relError;

      // Cria invite token
      const { data: invite, error: inviteError } = await supabase
        .schema('jarvis')
        .from('relationship_invites')
        .insert({
          relationship_id:  rel.id,
          invited_by:       authUUID,
          invited_user_id:  targetUser.auth_user_id,  // ← UUID direto, não email
          invited_email:    targetUser.email ?? contactEmail,
          relationship_type: relationshipType,
        })
        .select('token')
        .single();

      if (inviteError) throw inviteError;

      const deepLink = `jarvis://invite/${invite.token}`;

      // Push notification
      let pushSent = false;
      if (targetUser.push_token) {
        await sendPush(
          targetUser.push_token,
          '🔗 Novo convite de vínculo',
          `${inviterName} quer se vincular com você no Lev.`,
          { screen: 'Vinculos', token: invite.token, deepLink }
        );
        pushSent = true;
      }

      return NextResponse.json({ ok: true, inviteLink: deepLink, pushSent }, { status: 201 });
    }

    // ── 4b. Convidado NÃO tem conta ──────────────────────────
    if (!contactEmail) {
      return NextResponse.json({ error: 'Email é obrigatório para convidar alguém sem conta.' }, { status: 400 });
    }

    const { data: invite, error: inviteError } = await supabase
      .schema('jarvis')
      .from('relationship_invites')
      .insert({
        relationship_id:   null,          // criado quando ele aceitar
        invited_by:        authUUID,
        invited_user_id:   null,          // não tem conta ainda
        invited_email:     contactEmail,
        relationship_type: relationshipType,
      })
      .select('token')
      .single();

    if (inviteError) throw inviteError;

    const deepLink = `jarvis://invite/${invite.token}`;
    // Link web de fallback — funciona no browser e redireciona para o app
    const webLink  = `https://jarvis-core-three.vercel.app/invite/${invite.token}`;

    // Envia email para quem não tem conta
    await sendInviteEmail(contactEmail, inviterName, webLink);

    return NextResponse.json({
      ok:         true,
      inviteLink: webLink,   // link web para compartilhar (funciona sem app)
      deepLink,              // deep link direto para o app
      pushSent:   false,
      newUser:    true,
    }, { status: 201 });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
