// lib/modules/relationships/permissions.ts
import { supabase } from '@/lib/jarvis';
import { invalidateContextField } from '@/lib/services/context-cache';
export async function getActivePartnersBySetting(numericUserId: number, settingKey: string) {
  const { data, error } = await supabase
    .from('relationships')
    .select(`
      id,
      settings,
      user_id_a,
      user_id_b,
      partner_a:users!user_id_a(id, auth_user_id, name, preferred_name, nickname, email),
      partner_b:users!user_id_b(id, auth_user_id, name, preferred_name, nickname, email)
    `)
    .eq('status', 'active')
    .or(`user_id_a.eq.${numericUserId},user_id_b.eq.${numericUserId}`)
    .contains('settings', { [settingKey]: true });

  if (error) throw error;

  return (data || []).map(rel => {
    const isUserA = rel.user_id_a === numericUserId;
    const partner = isUserA ? rel.partner_b : rel.partner_a;

    // @ts-ignore - Tratando retorno do join do Supabase
    const p = Array.isArray(partner) ? partner[0] : partner;

    return {
      relId: rel.id,
      partnerId: p.id, // bigint_id
      partnerUUID: p.auth_user_id, // user_id (UUID)
      displayName: p.nickname || p.preferred_name || p.name || p.email,
      settings: rel.settings
    };
  });
}

export async function getActiveRelationship(userIdA: number, userIdB: number) {
  const { data, error } = await supabase
    .from('relationships')
    .select('id, settings, user_id_a, user_id_b')
    .eq('status', 'active')
    .or(`and(user_id_a.eq.${userIdA},user_id_b.eq.${userIdB}),and(user_id_a.eq.${userIdB},user_id_b.eq.${userIdA})`)
    .maybeSingle();

  // SEM invalidação aqui — função de leitura
  if (error) throw error;
  return data;
}

export async function updateRelationshipSetting(relId: string, key: string, value: any, userId?: number) {
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

  // Invalida persons do usuário afetado se userId for fornecido
  if (userId) {
    await invalidateContextField(userId, 'persons').catch(() => { });
  }

  return true;
}
