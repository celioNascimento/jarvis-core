// lib/modules/relationships/family.ts
import { supabase } from '@/lib/jarvis';

const FAMILY_LIMITS: Record<string, number> = {
  free: 2,
  personal: 1,
  family: 6,
  family_plus: 12,
};

/**
 * Tenta vincular um usuário a uma família respeitando os limites do plano.
 */
export async function tryJoinFamily(targetUserId: number, familyId: string): Promise<boolean> {
  const { count } = await supabase
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId);

  const { data: fam } = await supabase
    .from('families')
    .select('plan')
    .eq('id', familyId)
    .single();

  const max = FAMILY_LIMITS[fam?.plan ?? 'free'] ?? 2;

  if ((count ?? 0) < max) {
    const { error } = await supabase
      .from('users')
      .update({ family_id: familyId })
      .eq('id', targetUserId);
    
    return !error;
  }
  
  return false;
}