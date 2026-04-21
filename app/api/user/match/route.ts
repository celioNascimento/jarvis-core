import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/jarvis'; // schema jarvis

// ── Cliente público separado (user_profiles está em public, não em jarvis) ──


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

  console.log('[MATCH] ── Início ──────────────────────────────');
  console.log('[MATCH] authUUID do solicitante:', authUUID);

  try {
    const body = await req.json() as { identifiers: IdentifierInput[] };

    if (!Array.isArray(body.identifiers) || body.identifiers.length === 0) {
      console.log('[MATCH] Nenhum identificador recebido.');
      return NextResponse.json({ matched: [] });
    }

    console.log('[MATCH] Total de identificadores recebidos:', body.identifiers.length);
    console.log('[MATCH] Amostra (primeiros 10):', body.identifiers.slice(0, 10));

    // ── Normaliza entrada e monta nameMap ────────────────────
    const nameMap: Record<string, string> = {};
    const rawIds: string[] = body.identifiers.map(item => {
      if (typeof item === 'string') return item;
      const id = item.identifier.trim();
      const normalized = id.includes('@') ? id.toLowerCase() : normalizePhone(id);
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

    console.log('[MATCH] Emails extraídos:', emails.length, '— Amostra:', emails.slice(0, 5));
    console.log('[MATCH] Telefones extraídos:', phones.length, '— Amostra:', phones.slice(0, 5));

    const seen = new Set<string>();
    const results: Array<{
      auth_user_id:       string;
      display_name:       string;
      contact_name:       string | null;
      email_hint:         string | null;
      avatar_url:         string | null;
      matched_identifier: string;
    }> = [];

    // ── Busca por email ──────────────────────────────────────
    if (emails.length > 0) {
      console.log('[MATCH:EMAIL] Buscando em jarvis.users por', emails.length, 'emails...');

      const { data: byEmail, error: emailError } = await supabase
        .schema('jarvis')          // ← garante schema correto
        .from('users')
        .select('auth_user_id, name, preferred_name, nickname, avatar_url, email')
        .in('email', emails)
        .neq('auth_user_id', authUUID);

      if (emailError) {
        console.error('[MATCH:EMAIL] Erro na query:', emailError);
      } else {
        console.log('[MATCH:EMAIL] Rows retornadas:', byEmail?.length ?? 0);
        if (byEmail && byEmail.length > 0) {
          console.log('[MATCH:EMAIL] Usuários encontrados:', byEmail.map(u => ({
            auth_user_id: u.auth_user_id,
            name: u.name,
            email: u.email,
          })));
        }
      }

      (byEmail ?? []).forEach(u => {
        if (!u.auth_user_id || seen.has(u.auth_user_id)) return;
        seen.add(u.auth_user_id);
        const emailKey = (u.email ?? '').toLowerCase();
        results.push({
          auth_user_id:       u.auth_user_id,
          display_name:       u.preferred_name ?? u.nickname ?? u.name,
          contact_name:       nameMap[emailKey] ?? null,
          email_hint:         u.email ? maskEmail(u.email) : null,
          avatar_url:         u.avatar_url ?? null,
          matched_identifier: emailKey,
        });
      });
    }

    // ── Busca por telefone ───────────────────────────────────
    if (phones.length > 0) {
      console.log('[MATCH:PHONE] Buscando em public.user_profiles por', phones.length, 'telefones...');
      console.log('[MATCH:PHONE] Telefones normalizados:', phones.slice(0, 10));

      // Monta condição OR com cada telefone
      const phoneConditions = phones
        .map(p => `whatsapp.ilike.%${p}%,phone.ilike.%${p}%`)
        .join(',');

      console.log('[MATCH:PHONE] Condição OR (parcial):', phoneConditions.slice(0, 200));

      const { data: profileRows, error: profileError } = await supabase
        .from('user_profiles')
        .select('user_id, whatsapp, phone')
        .or(phoneConditions);

      if (profileError) {
        console.error('[MATCH:PHONE] Erro ao buscar user_profiles:', profileError);
      } else {
        console.log('[MATCH:PHONE] Profiles encontrados:', profileRows?.length ?? 0);
        if (profileRows && profileRows.length > 0) {
          console.log('[MATCH:PHONE] Dados:', profileRows.map(r => ({
            user_id: r.user_id,
            whatsapp: r.whatsapp,
            phone: r.phone,
          })));
        }
      }

      if (profileRows && profileRows.length > 0) {
        const userIdToPhone: Record<string, string> = {};

        profileRows.forEach(row => {
          const wp = normalizePhone(row.whatsapp ?? '');
          const ph = normalizePhone(row.phone ?? '');

          console.log(`[MATCH:PHONE] Row user_id=${row.user_id} | wp_norm="${wp}" | ph_norm="${ph}"`);

          const matched = phones.find(p => {
            const wpMatch = wp && (wp.includes(p) || p.includes(wp));
            const phMatch = ph && (ph.includes(p) || p.includes(ph));
            if (wpMatch) console.log(`[MATCH:PHONE]   ✓ whatsapp "${wp}" bate com "${p}"`);
            if (phMatch) console.log(`[MATCH:PHONE]   ✓ phone "${ph}" bate com "${p}"`);
            return wpMatch || phMatch;
          });

          if (matched) {
            userIdToPhone[String(row.user_id)] = matched;
          } else {
            console.log(`[MATCH:PHONE]   ✗ user_id=${row.user_id} não bateu com nenhum telefone da agenda`);
          }
        });

        const userIds = Object.keys(userIdToPhone).map(Number).filter(Boolean);
      
        if (userIds.length > 0) {
          const { data: userRows, error: userError } = await supabase
            .schema('jarvis')        // ← garante schema correto
            .from('users')
            .select('id, auth_user_id, name, preferred_name, nickname, avatar_url, email')
            .in('id', userIds)
            .neq('auth_user_id', authUUID);

          if (userError) {
            console.error('[MATCH:PHONE] Erro ao buscar jarvis.users:', userError);
          } else {
            console.log('[MATCH:PHONE] jarvis.users encontrados:', userRows?.length ?? 0);
            console.log('[MATCH:PHONE] Dados:', userRows?.map(u => ({
              id: u.id,
              auth_user_id: u.auth_user_id,
              name: u.name,
            })));
          }

          (userRows ?? []).forEach(u => {
            if (!u.auth_user_id || seen.has(u.auth_user_id)) return;
            seen.add(u.auth_user_id);
            const phoneKey = userIdToPhone[String(u.id)] ?? '';
            results.push({
              auth_user_id:       u.auth_user_id,
              display_name:       u.preferred_name ?? u.nickname ?? u.name,
              contact_name:       nameMap[phoneKey] ?? null,
              email_hint:         u.email ? maskEmail(u.email) : null,
              avatar_url:         u.avatar_url ?? null,
              matched_identifier: phoneKey,
            });
          });
        }
      }
    }

    return NextResponse.json({ matched: results });

  } catch (e: any) {
    console.error('[MATCH] Exceção não tratada:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}