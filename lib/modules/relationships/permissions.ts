// lib/modules/relationships/permissions.ts
import { supabase } from '@/lib/jarvis';

/**
 * Verifica se um usuário tem permissão para acessar um módulo de um parceiro.
 */
export async function hasModulePermission(
  authUserId: string, 
  partnerId: string, 
  moduleKey: 'shopping_enabled' | 'projects_enabled'
): Promise<boolean> {
  const { data } = await supabase
    .from('relationships')
    .select('settings')
    .eq('status', 'active')
    .or(`and(user_id_a.eq.${authUserId},user_id_b.eq.${partnerId}),and(user_id_a.eq.${partnerId},user_id_b.eq.${authUserId})`)
    .single();

  return !!data?.settings?.[moduleKey];
}