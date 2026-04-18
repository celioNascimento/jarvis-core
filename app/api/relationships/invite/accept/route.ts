import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// /api/relationships/invites/accept
//
// POST → aceita convite via token (vindo do deep link jarvis://invite/{token})
// Body: { token: string }
// Não requer autenticação prévia — o token é o mecanismo de segurança
// Mas se o usuário estiver logado, valida que é ele o destinatário
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
  const authUUID  = await getAuthUUID(authToken); // pode ser null se não logado ainda

  try {
    const { token } = await req.json();

    if (!token) {
      return NextResponse.json({ error: 'token é obrigatório' }, { status: 400 });
    }

    // Busca o convite pelo token
    const { data: invite, error: inviteError } = await supabase
      .from('relationship_invites')
      .select('id, token, relationship_id, invited_by, invited_email, expires_at, accepted_at')
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

    // Busca o vínculo
    const { data: rel, error: relError } = await supabase
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

    // Se o usuário está logado, valida que é ele o destinatário
    if (authUUID && rel.user_id_b !== authUUID) {
      return NextResponse.json(
        { error: 'Este convite não é para você.' },
        { status: 403 }
      );
    }

    const now = new Date().toISOString();

    // Ativa o vínculo
    const { data: updatedRel, error: updateRelError } = await supabase
      .from('relationships')
      .update({ status: 'active', connected_at: now })
      .eq('id', rel.id)
      .select()
      .single();

    if (updateRelError) throw updateRelError;

    // Marca o convite como aceito
    const { error: updateInviteError } = await supabase
      .from('relationship_invites')
      .update({ accepted_at: now })
      .eq('id', invite.id);

    if (updateInviteError) throw updateInviteError;

    // Notifica quem enviou o convite
    const { data: inviter } = await supabase
      .from('users')
      .select('push_token, preferred_name, nickname, name')
      .eq('auth_user_id', invite.invited_by)
      .maybeSingle();

    // Busca nome de quem aceitou
    let acceptorName = 'A pessoa convidada';
    if (authUUID) {
      const { data: acceptor } = await supabase
        .from('users')
        .select('preferred_name, nickname, name')
        .eq('auth_user_id', authUUID)
        .maybeSingle();
      acceptorName =
        acceptor?.preferred_name ?? acceptor?.nickname ?? acceptor?.name ?? acceptorName;
    }

    if (inviter?.push_token) {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to:    inviter.push_token,
          title: '🎉 Convite aceito!',
          body:  `${acceptorName} aceitou seu convite de vínculo.`,
          data:  { screen: 'Vinculos' },
          sound: 'default',
        }),
      });
    }

    return NextResponse.json({ ok: true, relationship: updatedRel });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}