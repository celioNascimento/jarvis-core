import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis'; // jarvis schema


function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

async function getAuthUUID(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  return `${local.slice(0, 2)}***@${domain}`;
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

function isPhone(q: string): boolean {
  return /^[\d\s\(\)\-\+]{7,}$/.test(q);
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
    // ── Busca por telefone ───────────────────────────────────
    if (isPhone(q)) {
      const phoneNorm = normalizePhone(q);

      const { data: profileRows, error: profileError } = await supabase
        .from('user_profiles')
        .select('user_id, whatsapp, phone')
        .or(`whatsapp.ilike.%${phoneNorm}%,phone.ilike.%${phoneNorm}%`);

      if (profileError) {
        console.error('[SEARCH:PHONE] Erro:', profileError);
        return NextResponse.json({ users: [] });
      }

      if (!profileRows || profileRows.length === 0) {
        return NextResponse.json({ users: [] });
      }

      const userIds = profileRows.map(r => r.user_id).filter(Boolean);

      const { data: userRows, error: userError } = await supabase
        .from('users')
        .select('id, auth_user_id, name, preferred_name, nickname, avatar_url, email')
        .in('id', userIds)
        .neq('auth_user_id', authUUID);

      if (userError) {
        console.error('[SEARCH:PHONE] Erro users:', userError);
        return NextResponse.json({ users: [] });
      }

      const users = (userRows ?? []).map(u => ({
        auth_user_id: u.auth_user_id,
        display_name: u.preferred_name ?? u.nickname ?? u.name,
        email_hint:   u.email ? maskEmail(u.email) : null,
        avatar_url:   u.avatar_url ?? null,
      }));

      return NextResponse.json({ users });
    }

    // ── Busca por nome ou email ──────────────────────────────
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

    const users = (data ?? []).map(u => ({
      auth_user_id: u.auth_user_id,
      display_name: u.preferred_name ?? u.nickname ?? u.name,
      email_hint:   u.email ? maskEmail(u.email) : null,
      avatar_url:   u.avatar_url ?? null,
    }));

    return NextResponse.json({ users });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}