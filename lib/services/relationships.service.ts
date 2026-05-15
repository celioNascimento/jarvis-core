// lib/services/relationships.service.ts
// V1.0.0 — Fonte Única da Verdade para Relacionamentos e Permissões

import { supabase } from '@/lib/jarvis';

// ─── HELPER: RESOLVER ID DO CONTATO ───────────────────────────────────────────
export async function coreResolverIdContato(identificador: string): Promise<number | null> {
  if (!identificador) return null;
  if (/^\d+$/.test(identificador)) return Number(identificador);

  const { data } = await supabase
    .schema('jarvis')
    .from('users')
    .select('id')
    .or(`email.ilike.%${identificador}%,name.ilike.%${identificador}%`)
    .limit(1)
    .maybeSingle();

  return data?.id || null;
}

// ─── ATUALIZAR PERMISSÃO DE MÓDULO (JSONB SETTINGS) ───────────────────────────
export type ModuloPermissao = 'shopping_enabled' | 'projects_enabled' | 'agenda_enabled';

export async function coreAlternarPermissaoModulo(userId: number, contatoId: number, modulo: ModuloPermissao, habilitar: boolean) {
  // 1. Busca o relacionamento ativo entre os dois
  const { data: rel, error: relError } = await supabase
    .schema('jarvis')
    .from('relationships')
    .select('id, settings')
    .eq('status', 'active')
    .or(`and(user_id_a.eq.${userId},user_id_b.eq.${contatoId}),and(user_id_a.eq.${contatoId},user_id_b.eq.${userId})`)
    .single();

  if (relError || !rel) {
    throw new Error('Vínculo ativo não encontrado com este contato.');
  }

  const currentSettings = rel.settings || {};
  
  if (currentSettings[modulo] === habilitar) {
    return { alterado: false, relId: rel.id };
  }

  // 2. Faz o merge do JSONB
  const newSettings = { ...currentSettings, [modulo]: habilitar };

  // 3. Salva no banco
  const { error: updateError } = await supabase
    .schema('jarvis')
    .from('relationships')
    .update({ settings: newSettings })
    .eq('id', rel.id);

  if (updateError) throw new Error(`Falha ao atualizar permissões: ${updateError.message}`);

  return { alterado: true, relId: rel.id };
}
