import { supabase } from '../jarvis';

export function assertNumericUserId(id: string, context: string): void {
  if (!/^\d+$/.test(id)) {
    throw new Error(`[${context}] userId invalido: esperado numerico, recebido "${id}"`);
  }
}

export async function canAccessResource(
  requesterAuthId: string,
  resourceOwnerNumericId: number,
  resourceSharedWith: string[] | null,
  requiredPrivacyLevel: number = 1
): Promise<boolean> {
  const { data: owner } = await supabase
    .from('users')
    .select('auth_user_id')
    .eq('id', resourceOwnerNumericId)
    .single();

  if (owner?.auth_user_id === requesterAuthId) return true;

  if (resourceSharedWith?.includes(requesterAuthId)) {
    const { data: rel } = await supabase
      .from('relationships')
      .select('privacy_level')
      .or(
        `and(user_id_a.eq.${requesterAuthId},user_id_b.eq.${owner?.auth_user_id}),` +
        `and(user_id_a.eq.${owner?.auth_user_id},user_id_b.eq.${requesterAuthId})`
      )
      .eq('status', 'active')
      .maybeSingle();

    return !rel || (rel.privacy_level ?? 0) >= requiredPrivacyLevel;
  }

  return false;
}