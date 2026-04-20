import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// GET /api/users/search?q={termo}
// Busca usuários cadastrados por nome ou email parcial.
// Retorna apenas dados públicos — email não é exposto.
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

// Mascara email: joao@gmail.com → jo***@gmail.com
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}***@${domain}`;
}

export async function GET(req: Request) {
  const token = extractToken(req);
  const authUUID = await getAuthUUID(token);
  if (!authUUID) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim() ?? '';

  if (q.length < 2) {
    return NextResponse.json({ users: [] });
  }

  try {
    // Busca por preferred_name, nickname, name ou email (parcial, case-insensitive)
    // Exclui o próprio usuário dos resultados
    const { data, error } = await supabase
      .from('users')
      .select('auth_user_id, name, preferred_name, nickname, avatar_url, email')
      .neq('auth_user_id', authUUID)
      .or(
        `preferred_name.ilike.%${q}%,` +
        `nickname.ilike.%${q}%,` +
        `name.ilike.%${q}%,` +
        `email.ilike.%${q}%`
      )
      .limit(10);

    if (error) throw error;

    // Monta resultado sem expor email completo
    const users = (data ?? []).map(u => ({
      auth_user_id: u.auth_user_id,
      display_name: u.preferred_name ?? u.nickname ?? u.name,
      // Mascara o email: joao@gmail.com → jo***@gmail.com
      email_hint: u.email
        ? maskEmail(u.email)
        : null,
      avatar_url: u.avatar_url ?? null,
    }));

    return NextResponse.json({ users });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
