// lib/modules/relationships/permissions.ts
import { supabase } from '@/lib/jarvis';

export async function getActivePartnersBySetting(numericUserId: number, settingKey: string) {
  const { data, error } = await supabase
    .from('relationships')
    .select(`
      id,
      settings,
      user_id_a,
      user_id_b,
      status,
      partner_a:users!user_id_a(id, name, preferred_name, nickname, email),
      partner_b:users!user_id_b(id, name, preferred_name, nickname, nickname, email)
    `)
    .eq('status', 'active')
    // Verifica se o usuário é parte da relação e se a flag no JSONB está true
    .or(`user_id_a.eq.${numericUserId},user_id_b.eq.${numericUserId}`)
    .contains('settings', { [settingKey]: true });

  if (error) throw error;

  // Formata o retorno para que o front/IA receba sempre o "outro" usuário
  return (data || []).map(rel => {
    const isUserA = rel.user_id_a === numericUserId;
    const partner = isUserA ? rel.partner_b : rel.partner_a;
    return {
      relId: rel.id,
      partnerId: partner.id,
      displayName: partner.nickname || partner.preferred_name || partner.name || partner.email,
      settings: rel.settings
    };
  });
}
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
