// lib/auth.ts
import { supabase } from './jarvis';

/**
 * Extrai o user_id numérico (BIGINT) a partir do token de acesso do Supabase.
 * @param token Bearer token (JWT) enviado no header Authorization
 * @returns ID numérico do usuário na tabela jarvis.users, ou null se inválido
 */
export async function getUserFromToken(token: string | undefined): Promise<number | null> {
  if (!token) {
    console.warn('[Auth] Token não fornecido');
    return null;
  }

  // 1. Validar o token com o Supabase Auth
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    console.error('[Auth] Token inválido:', error?.message);
    return null;
  }

  const authUserId = user.id; // UUID do Auth

  // 2. Buscar o id numérico correspondente na tabela jarvis.users
  const { data: profile, error: dbError } = await supabase
    .from('users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (dbError) {
    console.error('[Auth] Erro ao consultar usuário:', dbError.message);
    return null;
  }

  if (!profile) {
    console.warn('[Auth] Nenhum usuário encontrado com auth_user_id:', authUserId);
    return null;
  }

  return profile.id; // BIGINT
}