// lib/tools/executors/compras.ts
// V11.0.0 — Integrado ao Módulo de Relacionamentos (Zero Hardcoding)

import { supabase } from '@/lib/jarvis';
import { getPlaceId } from './lugares';
import { getEffectiveUserId } from '@/lib/modules/relationships';

// ─── HELPERS DE DOMÍNIO ──────────────────────────────────────────────────────

const isUUID = (str: string) => 
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);

/**
 * Resolve o UUID do projeto buscando por nome ou tag no contexto do usuário alvo.
 */
async function resolveProjectId(identifier: string, targetUserId: string): Promise<string | null> {
  if (!identifier) return null;
  if (isUUID(identifier)) return identifier;

  const { data } = await supabase
    .from('projects')
    .select('id')
    .eq('user_id', targetUserId)
    .or(`tag.eq.${identifier},name.ilike.%${identifier}%`)
    .limit(1)
    .single();

  return data ? data.id : null;
}

// ─── EXECUTORES ──────────────────────────────────────────────────────────────

/**
 * Adiciona um item à lista, resolvendo automaticamente o ID de destino (Alias).
 */
export async function executeAdicionarItemLista(
  p: { item: string; lugar?: string; category?: string; project_id?: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    // 1. Resolve para qual ID os dados devem ir (UUID ou Numérico do App)
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    
    // 2. Resolve dependências de lugar e projeto no contexto do targetId
    const pid = p.lugar ? await getPlaceId(p.lugar, authUserId) : null;
    const resolvedProjectId = p.project_id ? await resolveProjectId(p.project_id, targetId) : null;

    if (p.project_id && !resolvedProjectId) {
      return `Não encontrei o projeto "${p.project_id}". Verifique o nome ou a tag.`;
    }

    const { error } = await supabase
      .from('shopping_items')
      .upsert({
        user_id:    targetId,
        item:       p.item.trim(),
        place_id:   pid,
        done:       false,
        archived:   false,
        category:   p.category ?? 'outros',
        project_id: resolvedProjectId,
      }, { onConflict: 'user_id,item,place_id' });

    if (error) throw error;

    return `"${p.item}" adicionado à lista com sucesso.`;
  } catch (err: any) {
    return `Erro ao adicionar item: ${err.message}`;
  }
}

/**
 * Lista itens pendentes de um lugar específico.
 */
export async function executeVerLista(
  p: { lugar: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const pid = await getPlaceId(p.lugar, authUserId);
    
    if (!pid) return `Lista de "${p.lugar}" não encontrada.`;

    const { data: itens, error } = await supabase
      .from('shopping_items')
      .select('item, done, category, project_id')
      .eq('user_id', targetId)
      .eq('place_id', pid)
      .eq('archived', false)
      .order('done');

    if (error) throw error;
    if (!itens?.length) return `Sua lista em "${p.lugar}" está vazia.`;

    return `Lista ${p.lugar}:\n${itens
      .map(i => `${i.done ? '✅' : '•'} ${i.item} [${i.category}]${i.project_id ? ' 📁' : ''}`)
      .join('\n')}`;
  } catch (err: any) {
    return `Erro ao carregar lista: ${err.message}`;
  }
}

/**
 * Marca um item como concluído, respeitando o mapeamento de ID.
 */
export async function executeMarcarItemComprado(
  p: { item: string; lugar?: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    
    let query = supabase
      .from('shopping_items')
      .update({ done: true })
      .eq('user_id', targetId)
      .ilike('item', p.item.trim());

    if (p.lugar) {
      const pid = await getPlaceId(p.lugar, authUserId);
      if (pid) query = query.eq('place_id', pid);
    }

    const { error } = await query;
    if (error) throw error;

    return `"${p.item}" marcado como comprado ✅`;
  } catch (err: any) {
    return `Erro ao atualizar: ${err.message}`;
  }
}

/**
 * Lista materiais pendentes vinculados a um projeto.
 */
export async function executeListarComprasProjeto(
  p: { project_id: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const rid = await resolveProjectId(p.project_id, targetId);

    if (!rid) return `Projeto "${p.project_id}" não localizado.`;

    const { data, error } = await supabase
      .from('shopping_items')
      .select('item, category, done')
      .eq('user_id', targetId)
      .eq('project_id', rid)
      .eq('archived', false)
      .order('done');

    if (error) throw error;
    if (!data?.length) return 'Nenhum item de compra vinculado a este projeto.';

    return data
      .map(i => `${i.done ? '✅' : '•'} ${i.item} [${i.category}]`)
      .join('\n');
  } catch (err: any) {
    return `Erro ao listar projeto: ${err.message}`;
  }
}