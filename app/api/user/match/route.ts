import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// POST /api/users/match
//
// Recebe lista de emails/telefones da agenda do celular e
// retorna quais já têm conta no Lev.
// Devolve `matched_identifier` (o identificador original que
// bateu) para o frontend conseguir resolver o nome da agenda.
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

    const emails = identifiers.filter(id => id.includes('@')).map(e => e.toLowerCase());
    const phones = identifiers.filter(id => !id.includes('@')).map(normalizePhone);

    const seen = new Set<string>();
    const results: Array<{
      auth_user_id:       string;
      display_name:       string;
      email_hint:         string | null;
      avatar_url:         string | null;
      matched_identifier: string; // identificador original que fez o match
    }> = [];

    // ── Busca por email ──────────────────────────────────────
    if (emails.length > 0) {
      const { data: byEmail } = await supabase
        .schema('jarvis')
        .from('users')
        .select('auth_user_id, name, preferred_name, nickname, avatar_url, email')
        .in('email', emails)
        .neq('auth_user_id', authUUID);

      (byEmail ?? []).forEach(u => {
        if (seen.has(u.auth_user_id)) return;
        seen.add(u.auth_user_id);
        results.push({
          auth_user_id:       u.auth_user_id,
          display_name:       u.preferred_name ?? u.nickname ?? u.name,
          email_hint:         u.email ? maskEmail(u.email) : null,
          avatar_url:         u.avatar_url ?? null,
          matched_identifier: u.email.toLowerCase(), // email original para lookup no nameMap
        });
      });
    }

    // ── Busca por telefone (duas queries separadas) ──────────
    if (phones.length > 0) {
      // 1) Busca os user_ids que têm o telefone
      const phoneConditions = phones
        .map(p => `whatsapp.ilike.%${p}%,phone.ilike.%${p}%`)
        .join(',');

      const { data: profileRows } = await supabase
        .schema('jarvis')
        .from('user_profiles')
        .select('user_id, whatsapp, phone')
        .or(phoneConditions);

      if (profileRows && profileRows.length > 0) {
        // Monta mapa phone → matched_identifier original
        const phoneToIdentifier: Record<string, string> = {};
        profileRows.forEach(row => {
          const normalized = normalizePhone(row.whatsapp ?? row.phone ?? '');
          const match = phones.find(p => normalized.includes(p) || p.includes(normalized));
          if (match) phoneToIdentifier[String(row.user_id)] = match;
        });

        const userIds = profileRows.map(r => r.user_id).filter(Boolean);

        // 2) Busca os dados dos usuários
        const { data: userRows } = await supabase
          .schema('jarvis')
          .from('users')
          .select('id, auth_user_id, name, preferred_name, nickname, avatar_url, email')
          .in('id', userIds)
          .neq('auth_user_id', authUUID);

        (userRows ?? []).forEach(u => {
          if (seen.has(u.auth_user_id)) return;
          seen.add(u.auth_user_id);
          results.push({
            auth_user_id:       u.auth_user_id,
            display_name:       u.preferred_name ?? u.nickname ?? u.name,
            email_hint:         u.email ? maskEmail(u.email) : null,
            avatar_url:         u.avatar_url ?? null,
            matched_identifier: phoneToIdentifier[String(u.id)] ?? '',
          });
        });
      }
    }

    return NextResponse.json({ matched: results });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
