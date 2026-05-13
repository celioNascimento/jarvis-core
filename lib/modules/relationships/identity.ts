// lib/modules/relationships/identity.ts
import { supabase } from '@/lib/jarvis';

/**
 * Resolve o ID de banco (BigInt) para persistência.
 * Verifica se o UUID logado possui um Alias ativo.
 */
export async function getEffectiveUserId(authUserId: string, fallbackId: string): Promise<string> {
  try {
    const { data } = await supabase
      .from('relationships')
      .select('user_id_b')
      .eq('user_id_a', authUserId)
      .eq('status', 'active')
      .contains('settings', { is_alias: true })
      .maybeSingle();

    return data?.user_id_b || fallbackId;
  } catch {
    return fallbackId;
  }
}

/**
 * Retorna o UUID de autenticação de um ID numérico (BigInt).
 */
export async function getAuthUUIDFromNumeric(numericId: string): Promise<string | null> {
  const { data } = await supabase
    .from('users')
    .select('auth_user_id')
    .eq('id', numericId)
    .maybeSingle();
  
  return data?.auth_user_id || null;
}