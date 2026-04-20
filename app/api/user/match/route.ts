import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// POST /api/users/match
//
// Recebe lista de { identifier, name } da agenda do celular e
// retorna quais já têm conta no Lev, com contact_name resolvido.
// Compatível também com string[] (formato legado).
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

type IdentifierInput = string | { identifier: string; name: string };

export async function POST(req: Request) {
  const token = extractToken(req);
  const authUUID = await getAuthUUID(token);
  if (!authUUID) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const body = await req.json() as { identifiers: IdentifierInput[] };

    if (!Array.isArray(body.identifiers) || body.identifiers.length === 0) {
      return NextResponse.json({ matched: [] });
    }

    const nameMap: Record<string, string> = {};
    const rawIds: string[] = body.identifiers.map(item => {
      if (typeof item === 'string') return item;
      const id = item.identifier.trim();
      const normalized = id.includes('@')
        ? id.toLowerCase()
        : normalizePhone(id);
      if (item.name) nameMap[normalized] = item.name;
      return id;
    });

    const emails = rawIds
      .filter(id => id.includes('@'))
      .map(e => e.toLowerCase());

    const phones = rawIds
      .filter(id => !id.includes('@'))
      .map(normalizePhone)
      .filter(Boolean);

    const seen = new Set<string>();
    const results: Array<{
      auth_user_id:      string;
      display_name:      string;
      contact_name:      string | null;
      email_hint:        string | null;
      avatar_url:        string | null;
      matched_identifier: string;   // ✅ ADICIONADO
    }> = [];

    // ─── Busca por email ──────────────────────────────────────
    if (emails.length > 0) {
      const { data: byEmail } = await supabase
        .from('users')
        .select('auth_user_id, name, preferred_name, nickname, avatar_url, email')
        .in('email', emails)
        .neq('auth_user_id', authUUID);

      (byEmail ?? []).forEach(u => {
        if (!u.auth_user_id || seen.has(u.auth_user_id)) return;
        seen.add(u.auth_user_id);
        const emailKey = (u.email ?? '').toLowerCase();
        results.push({
          auth_user_id: u.auth_user_id,
          display_name: u.preferred_name ?? u.nickname ?? u.name,
          contact_name: nameMap[emailKey] ?? null,
          email_hint:   u.email ? maskEmail(u.email) : null,
          avatar_url:   u.avatar_url ?? null,
          matched_identifier: emailKey,   // ✅ ADICIONADO
        });
      });
    }

    // ─── Busca por telefone ───────────────────────────────────
    if (phones.length > 0) {
      const phoneConditions = phones
        .map(p => `whatsapp.ilike.%${p}%,phone.ilike.%${p}%`)
        .join(',');

      const { data: profileRows } = await supabase
        .from('user_profiles')
        .select('user_id, whatsapp, phone')
        .or(phoneConditions);

      if (profileRows && profileRows.length > 0) {
        const userIdToPhone: Record<string, string> = {};
        profileRows.forEach(row => {
          const wp = normalizePhone(row.whatsapp ?? '');
          const ph = normalizePhone(row.phone ?? '');
          const matched = phones.find(p =>
            (wp && (wp.includes(p) || p.includes(wp))) ||
            (ph && (ph.includes(p) || p.includes(ph)))
          );
          if (matched) userIdToPhone[String(row.user_id)] = matched;
        });

        const userIds = profileRows.map(r => r.user_id).filter(Boolean);
        const { data: userRows } = await supabase
          .from('users')
          .select('id, auth_user_id, name, preferred_name, nickname, avatar_url, email')
          .in('id', userIds)
          .neq('auth_user_id', authUUID);

        (userRows ?? []).forEach(u => {
          if (!u.auth_user_id || seen.has(u.auth_user_id)) return;
          seen.add(u.auth_user_id);
          const phoneKey = userIdToPhone[String(u.id)] ?? '';
          results.push({
            auth_user_id: u.auth_user_id,
            display_name: u.preferred_name ?? u.nickname ?? u.name,
            contact_name: nameMap[phoneKey] ?? null,
            email_hint:   u.email ? maskEmail(u.email) : null,
            avatar_url:   u.avatar_url ?? null,
            matched_identifier: phoneKey,   // ✅ ADICIONADO
          });
        });
      }
    }

    return NextResponse.json({ matched: results });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}