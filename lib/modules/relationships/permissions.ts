// lib/modules/relationships/permissions.ts
import { supabase } from '@/lib/jarvis';

/**
 * Busca um relacionamento ativo entre dois usuários, independente de quem iniciou.
 */
export async function getActiveRelationship(userIdA: number, userIdB: number) {
  const { data, error } = await supabase
    .from('relationships')
    .select('id, settings, user_id_a, user_id_b')
    .eq('status', 'active')
    .or(`and(user_id_a.eq.${userIdA},user_id_b.eq.${userIdB}),and(user_id_a.eq.${userIdB},user_id_b.eq.${userIdA})`)
    .maybeSingle(); // Essencial para evitar erro 406 no log

  if (error) throw error;
  return data;
}

/**
 * Atualiza uma chave específica dentro do JSONB de configurações.
 */
export async function updateRelationshipSetting(relId: string, key: string, value: any) {
  // Busca o estado atual primeiro para fazer o merge (evita sobrescrever outras chaves)
  const { data: rel } = await supabase
    .from('relationships')
    .select('settings')
    .eq('id', relId)
    .single();

  const newSettings = { ...(rel?.settings || {}), [key]: value };

  const { error } = await supabase
    .from('relationships')
    .update({ settings: newSettings })
    .eq('id', relId);

  if (error) throw error;
  return true;
}
