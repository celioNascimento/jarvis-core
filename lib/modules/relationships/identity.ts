// lib/modules/relationships/identity.ts
import { supabase } from '@/lib/jarvis';

/**
 * Resolve o ID real de destino (Alias) para persistência.
 * Se houver um mapeamento 'is_alias' ativo, retorna o user_id_b (Numérico).
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
  } catch (error) {
    console.error('[Identity] Erro ao resolver Alias:', error);
    return fallbackId;
  }
}