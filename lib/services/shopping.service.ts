// lib/services/shopping.service.ts
// V1.0.0 — Fonte Única da Verdade (SSOT) para Compras

import { supabase } from '@/lib/jarvis';
import { ShoppingItem } from '../types/shopping';
import { invalidateContextField } from '@/lib/services/context-cache';

// ─── 1. LISTAR COM MULTIPLAYER (APP E CHAT) ──────────────────────────────────
export async function coreListarCompras(userId: number) {
  // 1. Busca quais categorias foram compartilhadas com este usuário
  const { data: shares } = await supabase
    .from('shopping_shares')
    .select('owner_id, category')
    .eq('shared_with_id', userId);

  // 2. Monta a query dinâmica (Meus itens + Itens autorizados)
  let orQuery = `user_id.eq.${userId}`;
  if (shares && shares.length > 0) {
    const shareConditions = shares.map(s => `and(user_id.eq.${s.owner_id},category.eq.${s.category})`);
    orQuery += `,${shareConditions.join(',')}`;
  }

  // 3. Busca os itens com os nomes dos projetos populados
  const { data, error } = await supabase
    .from('shopping_items')
    .select(`
      *,
      projects ( name, tag )
    `)
    .or(orQuery)
    .eq('archived', false)
    .order('done', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Erro ao listar compras: ${error.message}`);
  return data;
}

// ─── 2. CRIAR ITEM ────────────────────────────────────────────────────────────
export async function coreCriarCompra(
  userId: number, 
  payload: { item: string; category?: string; project_id?: string; place_id?: string }
) {
  const { data, error } = await supabase
    .from('shopping_items')
    .insert({
      user_id: userId,
      item: payload.item.trim(),
      category: payload.category || 'outros',
      project_id: payload.project_id || null,
      place_id: payload.place_id || null,
      done: false,
      archived: false
    })
    .select()
    .single();

  if (error) throw new Error(`Falha ao criar item: ${error.message}`);
  await invalidateContextField(userId, 'shopping');
  return data;
}

// ─── HELPER DE PERMISSÃO (DRY) ────────────────────────────────────────────────
async function validarPermissao(userId: number, itemId: string) {
  const { data: itemData, error } = await supabase
    .from('shopping_items')
    .select('user_id, category')
    .eq('id', itemId)
    .single();

  if (error || !itemData) throw new Error('Item não encontrado.');
  if (Number(itemData.user_id) === userId) return true; // É o dono

  // Verifica na tabela de compartilhamento
  const { data: hasPermission } = await supabase
    .from('shopping_shares')
    .select('id')
    .eq('owner_id', itemData.user_id)
    .eq('shared_with_id', userId)
    .eq('category', itemData.category)
    .maybeSingle();

  if (!hasPermission) throw new Error('FORBIDDEN: Sem permissão para alterar este item.');
  return true;
}

// ─── 3. ATUALIZAR STATUS ──────────────────────────────────────────────────────
export async function coreAtualizarStatusCompra(userId: number, itemId: string, done: boolean) {
  await validarPermissao(userId, itemId);

  const { error } = await supabase
    .from('shopping_items')
    .update({ done })
    .eq('id', itemId);

  if (error) throw new Error(`Falha ao atualizar status: ${error.message}`);
  await invalidateContextField(userId, 'shopping');
}

// ─── 4. DELETAR ITEM ──────────────────────────────────────────────────────────
export async function coreDeletarCompra(userId: number, itemId: string) {
  await validarPermissao(userId, itemId);

  const { error } = await supabase
    .from('shopping_items')
    .delete()
    .eq('id', itemId);

  if (error) throw new Error(`Falha ao deletar item: ${error.message}`);
  await invalidateContextField(userId, 'shopping');
}
