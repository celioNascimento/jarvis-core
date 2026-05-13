// lib/modules/relationships/permissions.ts
import { supabase } from '@/lib/jarvis';

export interface PartnerIdentity {
  bigint_id: string;
  auth_uuid: string;
  contact_name: string;
}

/**
 * Busca todos os parceiros ativos que possuem compartilhamento de compras habilitado.
 */
export async function getActiveShoppingPartners(authUUID: string): Promise<PartnerIdentity[]> {
  const { data: relationships } = await supabase
    .from('relationships')
    .select('user_id_a, user_id_b, contact_name, settings')
    .eq('status', 'active')
    .or(`user_id_a.eq.${authUUID},user_id_b.eq.${authUUID}`);

  const activeUUIDs = (relationships ?? [])
    .filter(r => r.settings?.shopping_enabled === true)
    .map(r => r.user_id_a === authUUID ? r.user_id_b : r.user_id_a);

  if (activeUUIDs.length === 0) return [];

  const { data: partners } = await supabase
    .from('users')
    .select('id, auth_user_id, preferred_name, nickname, name')
    .in('auth_user_id', activeUUIDs);

  return (partners ?? []).map(p => ({
    bigint_id: p.id,
    auth_uuid: p.auth_user_id,
    contact_name: p.preferred_name || p.nickname || p.name || 'Contato'
  }));
}