// lib/chat/guards.ts
import { supabase } from '../jarvis';

/**
 * Verifica se um usuário (auth_user_id) pode acessar um recurso.
 * @param requesterAuthId - UUID do usuário que quer acessar
 * @param resourceOwnerNumericId - id (bigint) do dono do recurso
 * @param resourceSharedWith - array de auth_user_id com quem foi compartilhado
 * @param requiredPrivacyLevel - nível mínimo exigido (1 a 5)
 */
export async function canAccessResource(
  requesterAuthId: string,
  resourceOwnerNumericId: number,
  resourceSharedWith: string[] | null,
  requiredPrivacyLevel: number = 1
): Promise<boolean> {
  // 1. Dono sempre pode
  const { data: owner } = await supabase
    .from('users')
    .select('auth_user_id')
    .eq('id', resourceOwnerNumericId)
    .single();
  if (owner?.auth_user_id === requesterAuthId) return true;

  // 2. Verifica se está na lista shared_with
  if (resourceSharedWith?.includes(requesterAuthId)) {
    // 3. Opcional: checar privacy_level na relação (se existir)
    const { data: rel } = await supabase
      .from('relationships')
      .select('privacy_level')
      .or(`and(user_id_a.eq.${requesterAuthId},user_id_b.eq.${owner?.auth_user_id}),and(user_id_a.eq.${owner?.auth_user_id},user_id_b.eq.${requesterAuthId})`)
      .eq('status', 'active')
      .maybeSingle();
    return !rel || (rel.privacy_level ?? 0) >= requiredPrivacyLevel;
  }
  return false;
}