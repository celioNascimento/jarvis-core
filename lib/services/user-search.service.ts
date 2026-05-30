// lib/services/user-search.service.ts
//
// Queries de busca de usuários — sem lógica de HTTP, sem auth.
// Responsabilidade única: ler dados do Supabase e retornar DTOs.

import { supabase } from '@/lib/jarvis';
import { maskEmail, normalizePhone } from '@/lib/Utils/string';

// ── DTO de saída ──────────────────────────────────────────────────────────────

export interface UserSearchResult {
  auth_user_id: string;
  display_name: string | null;
  email_hint:   string | null;
  avatar_url:   string | null;
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Busca usuários por número de telefone (whatsapp ou phone).
 * Exclui o próprio usuário pelo auth_user_id.
 */
export async function searchByPhone(
  phone: string,
  excludeAuthUUID: string,
): Promise<UserSearchResult[]> {
  const phoneNorm = normalizePhone(phone);

  const { data: profileRows, error: profileError } = await supabase
    .from('user_profiles')
    .select('user_id, whatsapp, phone')
    .or(`whatsapp.ilike.%${phoneNorm}%,phone.ilike.%${phoneNorm}%`);

  if (profileError) {
    console.error('[UserSearch] searchByPhone — erro em user_profiles:', profileError);
    return [];
  }

  if (!profileRows?.length) return [];

  const userIds = profileRows.map(r => r.user_id).filter(Boolean);

  const { data: userRows, error: userError } = await supabase
    .from('users')
    .select('id, auth_user_id, name, preferred_name, nickname, avatar_url, email')
    .in('id', userIds)
    .neq('auth_user_id', excludeAuthUUID);

  if (userError) {
    console.error('[UserSearch] searchByPhone — erro em users:', userError);
    return [];
  }

  return (userRows ?? []).map(u => ({
    auth_user_id: u.auth_user_id,
    display_name: u.preferred_name ?? u.nickname ?? u.name ?? null,
    email_hint:   u.email ? maskEmail(u.email) : null,
    avatar_url:   u.avatar_url ?? null,
  }));
}

/**
 * Busca usuários por nome (preferred_name, nickname, name) ou email.
 * Exclui o próprio usuário pelo auth_user_id.
 */
export async function searchByName(
  query: string,
  excludeAuthUUID: string,
): Promise<UserSearchResult[]> {
  const { data, error } = await supabase
    .from('users')
    .select('auth_user_id, name, preferred_name, nickname, avatar_url, email')
    .neq('auth_user_id', excludeAuthUUID)
    .or(
      `preferred_name.ilike.%${query}%,` +
      `nickname.ilike.%${query}%,` +
      `name.ilike.%${query}%,` +
      `email.ilike.%${query}%`
    )
    .limit(10);

  if (error) {
    console.error('[UserSearch] searchByName — erro em users:', error);
    throw new Error(error.message);
  }

  return (data ?? []).map(u => ({
    auth_user_id: u.auth_user_id,
    display_name: u.preferred_name ?? u.nickname ?? u.name ?? null,
    email_hint:   u.email ? maskEmail(u.email) : null,
    avatar_url:   u.avatar_url ?? null,
  }));
}