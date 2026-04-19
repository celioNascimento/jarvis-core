import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// POST /api/relationships/invite
//
<<<<<<< HEAD
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
=======
// Fluxo:
//   1. Valida o convidador
//   2. Verifica se o email já tem conta
//      a) TEM conta  → cria relationship pending + invite token + envia push
//      b) NÃO tem    → cria só o invite token (sem relationship ainda)
//         o relationship é criado em /invite/accept quando ele entrar no app
//   3. Retorna inviteLink = jarvis://invite/{token}
//      (o frontend exibe e/ou compartilha esse link)
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
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
<<<<<<< HEAD
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
=======
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
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

<<<<<<< HEAD
=======
    const contactTrimmed = contact.trim().toLowerCase();

>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
    // ── 1. Quem está convidando ──────────────────────────────
    const { data: inviter } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id, name, preferred_name, nickname')
      .eq('auth_user_id', authUUID)
      .maybeSingle();

    if (!inviter) {
      return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 });
    }

    const inviterName = inviter.preferred_name ?? inviter.nickname ?? inviter.name ?? 'Alguém';

<<<<<<< HEAD
    // ── 2. Resolve o usuário alvo ────────────────────────────
=======
    // ── 2. O convidado já tem conta? ─────────────────────────
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
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
<<<<<<< HEAD
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
=======
        .select('auth_user_id, name, preferred_name, nickname, push_token')
        .eq('email', contactTrimmed)
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
        .maybeSingle();
      targetUser = data;
    }

    // Impede auto-convite
    if (targetUser?.auth_user_id === authUUID) {
      return NextResponse.json({ error: 'Você não pode se convidar.' }, { status: 400 });
    }

    // ── 3. Verifica convite pendente já existente ────────────
<<<<<<< HEAD
    // Busca por auth_uuid (usuário com conta) ou por email (sem conta)
    const inviteQuery = supabase
=======
    // Evita duplicar convites para o mesmo email/telefone
    const { data: existingInvite } = await supabase
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
      .schema('jarvis')
      .from('relationship_invites')
      .select('id, token, accepted_at, expires_at')
      .eq('invited_by', authUUID)
<<<<<<< HEAD
      .is('accepted_at', null);

    const { data: existingInvite } = targetUser
      ? await inviteQuery.eq('invited_user_id', targetUser.auth_user_id).maybeSingle()
      : await inviteQuery.eq('invited_email', contactEmail ?? '').maybeSingle();

    if (existingInvite) {
=======
      .eq('invited_email', contactTrimmed)
      .is('accepted_at', null)
      .maybeSingle();

    if (existingInvite) {
      // Se ainda não expirou, devolve o mesmo link
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
      if (new Date(existingInvite.expires_at) > new Date()) {
        const deepLink = `jarvis://invite/${existingInvite.token}`;
        return NextResponse.json({
          ok:         true,
          inviteLink: deepLink,
          pushSent:   false,
          reused:     true,
<<<<<<< HEAD
          message:    'Convite já enviado. Compartilhe o link abaixo.',
        });
      }
      // Expirado — deleta para criar novo
=======
          message:    'Convite já enviado anteriormente. Use o link abaixo.',
        });
      }
      // Expirado — remove para criar novo
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
      await supabase
        .schema('jarvis')
        .from('relationship_invites')
        .delete()
        .eq('id', existingInvite.id);
    }

<<<<<<< HEAD
    // ── 4a. Convidado TEM conta ──────────────────────────────
    if (targetUser) {
      // Verifica vínculo duplicado
=======
    // ── 4a. Convidado TEM conta → cria relationship + invite ─
    if (targetUser) {
      // Verifica vínculo ativo ou pendente entre os dois
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
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
<<<<<<< HEAD
        targetUser.preferred_name ?? targetUser.nickname ?? targetUser.name ?? contactEmail ?? 'Contato';

      // Cria relationship pending
=======
        targetUser.preferred_name ?? targetUser.nickname ?? targetUser.name ?? contactTrimmed;

      // Cria o vínculo como pending
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
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

<<<<<<< HEAD
      // Cria invite token
=======
      // Cria o token de convite vinculado ao relationship
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
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

<<<<<<< HEAD
      // Push notification
=======
      // Envia push se o alvo tem token
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
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

<<<<<<< HEAD
      return NextResponse.json({ ok: true, inviteLink: deepLink, pushSent }, { status: 201 });
    }

    // ── 4b. Convidado NÃO tem conta ──────────────────────────
    if (!contactEmail) {
      return NextResponse.json({ error: 'Email é obrigatório para convidar alguém sem conta.' }, { status: 400 });
    }

=======
      return NextResponse.json({
        ok:           true,
        inviteLink:   deepLink,
        pushSent,
      }, { status: 201 });
    }

    // ── 4b. Convidado NÃO tem conta ──────────────────────────
    // Cria só o invite (sem relationship_id) para quando ele se cadastrar
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
    const { data: invite, error: inviteError } = await supabase
      .schema('jarvis')
      .from('relationship_invites')
      .insert({
<<<<<<< HEAD
        relationship_id:   null,          // criado quando ele aceitar
        invited_by:        authUUID,
        invited_user_id:   null,          // não tem conta ainda
        invited_email:     contactEmail,
        relationship_type: relationshipType,
=======
        relationship_id:   null,       // será preenchido em /invite/accept
        invited_by:        authUUID,
        invited_email:     contactTrimmed,
        relationship_type: relationshipType, // guardamos o tipo aqui
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
      })
      .select('token')
      .single();

    if (inviteError) throw inviteError;

    const deepLink = `jarvis://invite/${invite.token}`;
<<<<<<< HEAD
    // Link web de fallback — funciona no browser e redireciona para o app
    const webLink  = `https://jarvis-core-three.vercel.app/invite/${invite.token}`;

    // Envia email para quem não tem conta
    await sendInviteEmail(contactEmail, inviterName, webLink);

    return NextResponse.json({
      ok:         true,
      inviteLink: webLink,   // link web para compartilhar (funciona sem app)
      deepLink,              // deep link direto para o app
      pushSent:   false,
=======

    return NextResponse.json({
      ok:         true,
      inviteLink: deepLink,
      pushSent:   false,
      // Frontend deve orientar o convidador a compartilhar o link
      // pois o convidado precisa instalar o app e se cadastrar primeiro
>>>>>>> b68f1992bb5b18690e720eee9a9fb56bbb7ceedd
      newUser:    true,
    }, { status: 201 });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
