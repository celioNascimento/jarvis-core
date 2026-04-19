import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// POST /api/users/match
//
// Recebe uma lista de emails e telefones dos contatos do celular
// e retorna quais deles já têm conta no Lev.
// Usado pelo InviteModal para mostrar "seus contatos no app".
// Não expõe o email completo — apenas email_hint mascarado.
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

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  return `${local.slice(0, 2)}***@${domain}`;
}

// Normaliza telefone: remove tudo que não é dígito
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

export async function POST(req: Request) {
  const token = extractToken(req);
  const authUUID = await getAuthUUID(token);
  if (!authUUID) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const { identifiers } = await req.json() as { identifiers: string[] };

    if (!Array.isArray(identifiers) || identifiers.length === 0) {
      return NextResponse.json({ matched: [] });
    }

    // Separa emails de telefones
    const emails = identifiers.filter(id => id.includes('@')).map(e => e.toLowerCase());
    const phones = identifiers.filter(id => !id.includes('@')).map(normalizePhone);

    const results: Array<{
      auth_user_id: string;
      display_name: string;
      email_hint: string | null;
      avatar_url: string | null;
    }> = [];

    // Busca por email
    if (emails.length > 0) {
      const { data: byEmail } = await supabase
        .schema('jarvis')
        .from('users')
        .select('auth_user_id, name, preferred_name, nickname, avatar_url, email')
        .in('email', emails)
        .neq('auth_user_id', authUUID);

      (byEmail ?? []).forEach(u => {
        results.push({
          auth_user_id: u.auth_user_id,
          display_name: u.preferred_name ?? u.nickname ?? u.name,
          email_hint:   u.email ? maskEmail(u.email) : null,
          avatar_url:   u.avatar_url ?? null,
        });
      });
    }

    // Busca por whatsapp/telefone (campo na user_profiles)
    if (phones.length > 0) {
      const { data: byPhone } = await supabase
        .schema('jarvis')
        .from('user_profiles')
        .select('user_id, whatsapp, phone, users!inner(auth_user_id, name, preferred_name, nickname, avatar_url, email)')
        .or(phones.map(p => `whatsapp.ilike.%${p}%,phone.ilike.%${p}%`).join(','));

      (byPhone ?? []).forEach((row: any) => {
        const u = row.users;
        if (!u || u.auth_user_id === authUUID) return;
        // Evita duplicata (pode já ter vindo pelo email)
        if (results.some(r => r.auth_user_id === u.auth_user_id)) return;
        results.push({
          auth_user_id: u.auth_user_id,
          display_name: u.preferred_name ?? u.nickname ?? u.name,
          email_hint:   u.email ? maskEmail(u.email) : null,
          avatar_url:   u.avatar_url ?? null,
        });
      });
    }

    return NextResponse.json({ matched: results });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}