import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// POST /api/relationships/invite/accept
//
// Body: { token: string }
// Auth: Bearer {supabase_access_token}  ← obrigatório aqui
//
// Fluxo:
//   1. Valida o token + sessão do aceitador
//   2. Se o invite tem relationship_id → apenas ativa o vínculo (pending → active)
//   3. Se NÃO tem relationship_id (convidado não tinha conta na época) →
//      cria o relationship agora e ativa
//   4. Notifica quem convidou via push
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
  const authToken = extractToken(req);
  const authUUID  = await getAuthUUID(authToken);
  if (!authUUID) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const { token } = await req.json();
    if (!token) {
      return NextResponse.json({ error: 'token é obrigatório' }, { status: 400 });
    }

    // ── 1. Busca o convite ───────────────────────────────────
    const { data: invite, error: inviteError } = await supabase
      .schema('jarvis')
      .from('relationship_invites')
      .select('id, token, relationship_id, invited_by, invited_email, expires_at, accepted_at, relationship_type')
      .eq('token', token)
      .maybeSingle();

    if (inviteError || !invite) {
      return NextResponse.json({ error: 'Convite inválido ou não encontrado.' }, { status: 404 });
    }
    if (invite.accepted_at) {
      return NextResponse.json({ error: 'Este convite já foi aceito.' }, { status: 409 });
    }
    if (new Date(invite.expires_at) < new Date()) {
      return NextResponse.json({ error: 'Este convite expirou.' }, { status: 410 });
    }
    // Não pode aceitar o próprio convite
    if (invite.invited_by === authUUID) {
      return NextResponse.json({ error: 'Você não pode aceitar seu próprio convite.' }, { status: 403 });
    }

    const now = new Date().toISOString();
    let relationshipId: string;

    // ── 2a. Invite JÁ tem relationship_id (convidado tinha conta) ──
    if (invite.relationship_id) {
      const { data: rel, error: relError } = await supabase
        .schema('jarvis')
        .from('relationships')
        .select('id, user_id_a, user_id_b, status')
        .eq('id', invite.relationship_id)
        .single();

      if (relError || !rel) {
        return NextResponse.json({ error: 'Vínculo não encontrado.' }, { status: 404 });
      }
      if (rel.status !== 'pending') {
        return NextResponse.json({ error: 'Este vínculo não está mais pendente.' }, { status: 409 });
      }
      // Garante que quem aceita é o user_id_b
      if (rel.user_id_b !== authUUID) {
        return NextResponse.json({ error: 'Este convite não é para você.' }, { status: 403 });
      }

      const { error: updateErr } = await supabase
        .schema('jarvis')
        .from('relationships')
        .update({ status: 'active', connected_at: now })
        .eq('id', rel.id);

      if (updateErr) throw updateErr;
      relationshipId = rel.id;

    // ── 2b. Invite SEM relationship_id (convidado não tinha conta) ─
    } else {
      // Verifica se já existe vínculo entre os dois (pode ter se cadastrado e tentado de novo)
      const { data: existing } = await supabase
        .schema('jarvis')
        .from('relationships')
        .select('id, status')
        .or(
          `and(user_id_a.eq.${invite.invited_by},user_id_b.eq.${authUUID}),` +
          `and(user_id_a.eq.${authUUID},user_id_b.eq.${invite.invited_by})`
        )
        .in('status', ['active', 'pending'])
        .maybeSingle();

      if (existing?.status === 'active') {
        return NextResponse.json({ error: 'Já existe um vínculo ativo com essa pessoa.' }, { status: 409 });
      }

      // Busca nome de quem convidou para preencher contact_name
      const { data: inviter } = await supabase
        .schema('jarvis')
        .from('users')
        .select('preferred_name, nickname, name')
        .eq('auth_user_id', invite.invited_by)
        .maybeSingle();

      const inviterName =
        inviter?.preferred_name ?? inviter?.nickname ?? inviter?.name ?? 'Contato';

      // Busca nome de quem está aceitando
      const { data: acceptor } = await supabase
        .schema('jarvis')
        .from('users')
        .select('preferred_name, nickname, name, email')
        .eq('auth_user_id', authUUID)
        .maybeSingle();

      const acceptorName =
        acceptor?.preferred_name ?? acceptor?.nickname ?? acceptor?.name ?? invite.invited_email;

      const relType = invite.relationship_type ?? 'other';

      // Cria o relationship agora, já como active
      const { data: rel, error: relError } = await supabase
        .schema('jarvis')
        .from('relationships')
        .insert({
          user_id_a:         invite.invited_by,  // quem convidou
          user_id_b:         authUUID,            // quem aceitou
          relationship_type: relType,
          type_a:            relType,
          type_b:            relType,
          status:            'active',
          initiated_by:      invite.invited_by,
          is_external:       false,
          contact_name:      acceptorName,        // nome de quem aceitou (perspectiva de A)
          connected_at:      now,
        })
        .select('id')
        .single();

      if (relError) throw relError;
      relationshipId = rel.id;

      // Atualiza o invite com o relationship_id criado
      await supabase
        .schema('jarvis')
        .from('relationship_invites')
        .update({ relationship_id: rel.id })
        .eq('id', invite.id);
    }

    // ── 3. Marca o convite como aceito ───────────────────────
    await supabase
      .schema('jarvis')
      .from('relationship_invites')
      .update({ accepted_at: now })
      .eq('id', invite.id);

    // ── 4. Notifica quem convidou ────────────────────────────
    const { data: inviterUser } = await supabase
      .schema('jarvis')
      .from('users')
      .select('push_token, preferred_name, nickname, name')
      .eq('auth_user_id', invite.invited_by)
      .maybeSingle();

    const { data: acceptorUser } = await supabase
      .schema('jarvis')
      .from('users')
      .select('preferred_name, nickname, name')
      .eq('auth_user_id', authUUID)
      .maybeSingle();

    const acceptorName =
      acceptorUser?.preferred_name ?? acceptorUser?.nickname ?? acceptorUser?.name ?? 'A pessoa convidada';

    if (inviterUser?.push_token) {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to:    inviterUser.push_token,
          title: '🎉 Convite aceito!',
          body:  `${acceptorName} aceitou seu convite de vínculo.`,
          data:  { screen: 'Vinculos' },
          sound: 'default',
        }),
      });
    }

    return NextResponse.json({ ok: true, relationshipId });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
