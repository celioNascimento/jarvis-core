// lib/tools/executors/compras.ts
// V10.3.1 — Dinâmico, Sem Hardcoding e Resiliente ao Build

import { supabase } from '@/lib/jarvis';
import { getPlaceId } from './lugares';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Verifica se uma string é um UUID válido.
 */
const isUUID = (str: string) => 
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);

/**
 * Busca dinamicamente se o usuário atual possui um "Alias" (ID Numérico) 
 * vinculado ao seu UUID de autenticação na tabela de relacionamentos.
 */
async function resolveEffectiveUserId(authUserId: string, fallbackId: string): Promise<string> {
  try {
    const { data, error } = await supabase
      .schema('jarvis')
      .from('relationships')
      .select('user_id_b')
      .eq('user_id_a', authUserId)
      .eq('status', 'active')
      // Filtramos por registros que possuam a flag de alias no JSONB
      .contains('settings', { is_alias: true })
      .maybeSingle();

    if (error || !data?.user_id_b) return fallbackId;
    return data.user_id_b;
  } catch {
    return fallbackId;
  }
}

/**
 * Resolve o UUID do projeto com base no nome, tag ou ID fornecido.
 */
async function resolveProjectId(identifier: string, targetUserId: string): Promise<string | null> {
  if (!identifier) return null;
  if (isUUID(identifier)) return identifier;

  const { data } = await supabase
    .schema('jarvis')
    .from('projects')
    .select('id')
    .eq('user_id', targetUserId)
    .or(`tag.eq.${identifier},name.ilike.%${identifier}%`)
    .limit(1)
    .single();

  return data ? data.id : null;
}

// ─── EXECUTORES EXPORTADOS ────────────────────────────────────────────────────

export async function executeAdicionarItemLista(
  p: { item: string; lugar?: string; category?: string; project_id?: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    // Resolve o ID de destino (UUID ou Numérico) via tabela de relacionamentos
    const effectiveId = await resolveEffectiveUserId(authUserId, numericUserId);
    
    let pid: string | null = null;
    if (p.lugar) {
      pid = await getPlaceId(p.lugar, authUserId);
    }

    const resolvedProjectId = p.project_id 
      ? await resolveProjectId(p.project_id, effectiveId) 
      : null;

    if (p.project_id && !resolvedProjectId) {
      return `Não encontrei o projeto "${p.project_id}".`;
    }

    const { error } = await supabase
      .from('shopping_items')
      .upsert({
        user_id:    effectiveId,
        item:       p.item.trim(),
        place_id:   pid,
        done:       false,
        archived:   false,
        category:   p.category ?? 'outros',
        project_id: resolvedProjectId,
      }, { onConflict: 'user_id,item,place_id' });

    if (error) return `Erro ao salvar no banco: ${error.message}`;

    const destMsg = effectiveId !== authUserId ? ` (mapeado para ID: ${effectiveId})` : '';
    return `"${p.item}" adicionado à lista${destMsg}.`;
  } catch (err: any) {
    return `Erro de execução: ${err.message}`;
  }
}

export async function executeVerLista(
  p: { lugar: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const effectiveId = await resolveEffectiveUserId(authUserId, numericUserId);
    const pid = await getPlaceId(p.lugar, authUserId);
    
    if (!pid) return `Lista de "${p.lugar}" não encontrada.`;

    const { data: itens, error } = await supabase
      .from('shopping_items')
      .select('item, done, category, project_id')
      .eq('user_id', effectiveId)
      .eq('place_id', pid)
      .eq('archived', false)
      .order('done');

    if (error) return `Erro ao buscar itens: ${error.message}`;
    if (!itens?.length) return `Sua lista em "${p.lugar}" está vazia.`;

    return `Lista ${p.lugar}:\n${itens
      .map(i => `${i.done ? '✅' : '•'} ${i.item} [${i.category}]${i.project_id ? ' 📁' : ''}`)
      .join('\n')}`;
  } catch (err: any) {
    return `Erro: ${err.message}`;
  }
}

export async function executeMarcarItemComprado(
  p: { item: string; lugar?: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const effectiveId = await resolveEffectiveUserId(authUserId, numericUserId);
    
    let query = supabase
      .from('shopping_items')
      .update({ done: true })
      .eq('user_id', effectiveId)
      .ilike('item', p.item.trim());

    if (p.lugar) {
      const pid = await getPlaceId(p.lugar, authUserId);
      if (pid) query = query.eq('place_id', pid);
    }

    const { error } = await query;
    return error 
      ? `Erro ao atualizar item: ${error.message}` 
      : `"${p.item}" marcado como comprado ✅`;
  } catch (err: any) {
    return `Erro: ${err.message}`;
  }
}

export async function executeListarComprasProjeto(
  p: { project_id: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const effectiveId = await resolveEffectiveUserId(authUserId, numericUserId);
    const resolvedProjectId = await resolveProjectId(p.project_id, effectiveId);

    if (!resolvedProjectId) return `Projeto "${p.project_id}" não localizado.`;

    const { data, error } = await supabase
      .from('shopping_items')
      .select('item, category, done')
      .eq('user_id', effectiveId)
      .eq('project_id', resolvedProjectId)
      .eq('archived', false)
      .order('done');

    if (error) return `Erro ao listar compras: ${error.message}`;
    if (!data?.length) return 'Nenhum item vinculado a este projeto.';

    return data
      .map(i => `${i.done ? '✅' : '•'} ${i.item} [${i.category}]`)
      .join('\n');
  } catch (err: any) {
    return `Erro: ${err.message}`;
  }
}
