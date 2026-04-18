import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// POST /api/relationships/invite
//
// Fluxo:
//   1. Valida o convidador
//   2. Verifica se o email já tem conta
//      a) TEM conta  → cria relationship pending + invite token + envia push
//      b) NÃO tem    → cria só o invite token (sem relationship ainda)
//         o relationship é criado em /invite/accept quando ele entrar no app
//   3. Retorna inviteLink = jarvis://invite/{token}
//      (o frontend exibe e/ou compartilha esse link)
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

export async function POST(req: Request) {
  const authToken = extractToken(req);
  const authUUID  = await getAuthUUID(authToken);
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

    const contactTrimmed = contact.trim().toLowerCase();

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

    // ── 2. O convidado já tem conta? ─────────────────────────
    let targetUser: {
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
        .select('auth_user_id, name, preferred_name, nickname, push_token')
        .eq('email', contactTrimmed)
        .maybeSingle();
      targetUser = data;
    }

    // Impede auto-convite
    if (targetUser?.auth_user_id === authUUID) {
      return NextResponse.json({ error: 'Você não pode se convidar.' }, { status: 400 });
    }

    // ── 3. Verifica convite pendente já existente ────────────
    // Evita duplicar convites para o mesmo email/telefone
    const { data: existingInvite } = await supabase
      .schema('jarvis')
      .from('relationship_invites')
      .select('id, token, accepted_at, expires_at')
      .eq('invited_by', authUUID)
      .eq('invited_email', contactTrimmed)
      .is('accepted_at', null)
      .maybeSingle();

    if (existingInvite) {
      // Se ainda não expirou, devolve o mesmo link
      if (new Date(existingInvite.expires_at) > new Date()) {
        const deepLink = `jarvis://invite/${existingInvite.token}`;
        return NextResponse.json({
          ok:         true,
          inviteLink: deepLink,
          pushSent:   false,
          reused:     true,
          message:    'Convite já enviado anteriormente. Use o link abaixo.',
        });
      }
      // Expirado — remove para criar novo
      await supabase
        .schema('jarvis')
        .from('relationship_invites')
        .delete()
        .eq('id', existingInvite.id);
    }

    // ── 4a. Convidado TEM conta → cria relationship + invite ─
    if (targetUser) {
      // Verifica vínculo ativo ou pendente entre os dois
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
        targetUser.preferred_name ?? targetUser.nickname ?? targetUser.name ?? contactTrimmed;

      // Cria o vínculo como pending
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

      // Cria o token de convite vinculado ao relationship
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

      const deepLink = `jarvis://invite/${invite.token}`;

      // Envia push se o alvo tem token
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

      return NextResponse.json({
        ok:           true,
        inviteLink:   deepLink,
        pushSent,
      }, { status: 201 });
    }

    // ── 4b. Convidado NÃO tem conta ──────────────────────────
    // Cria só o invite (sem relationship_id) para quando ele se cadastrar
    const { data: invite, error: inviteError } = await supabase
      .schema('jarvis')
      .from('relationship_invites')
      .insert({
        relationship_id:   null,       // será preenchido em /invite/accept
        invited_by:        authUUID,
        invited_email:     contactTrimmed,
        relationship_type: relationshipType, // guardamos o tipo aqui
      })
      .select('token')
      .single();

    if (inviteError) throw inviteError;

    const deepLink = `jarvis://invite/${invite.token}`;

    return NextResponse.json({
      ok:         true,
      inviteLink: deepLink,
      pushSent:   false,
      // Frontend deve orientar o convidador a compartilhar o link
      // pois o convidado precisa instalar o app e se cadastrar primeiro
      newUser:    true,
    }, { status: 201 });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
