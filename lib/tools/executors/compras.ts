// lib/tools/executors/compras.ts
// V11.1.0 — Executores Migrados para a SSOT com Chaining de Schema Estrito

import { supabase } from '@/lib/jarvis';
import { getPlaceId } from './lugares';
import { 
  coreCriarCompra, 
  coreListarCompras, 
  coreAtualizarStatusCompra 
} from '@/lib/services/shopping.service';

const isUUID = (str: string) => 
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);

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
    .maybeSingle();

  return data ? data.id : null;
}

export async function executeAdicionarItemLista(
  p: { item: string; lugar?: string; category?: string; project_id?: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = Number(numericUserId);
    const pid = p.lugar ? await getPlaceId(p.lugar, authUserId) : null;
    const resolvedProjectId = p.project_id ? await resolveProjectId(p.project_id, numericUserId) : null;

    if (p.project_id && !resolvedProjectId) {
      return `Não encontrei o projeto "${p.project_id}". Verifique o nome ou a tag.`;
    }

    await coreCriarCompra(targetId, {
      item: p.item,
      category: p.category,
      project_id: resolvedProjectId || undefined, // 🔥 Força undefined no lugar de null
      place_id: pid || undefined                  // 🔥 Força undefined no lugar de null
    });

    return `"${p.item}" adicionado à lista com sucesso.`;
  } catch (err: any) {
    return `Erro ao adicionar item: ${err.message}`;
  }
}

export async function executeVerLista(
  p: { lugar: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = Number(numericUserId);
    const pid = await getPlaceId(p.lugar, authUserId);
    
    if (!pid) return `Lista de "${p.lugar}" não encontrada.`;

    const itens = await coreListarCompras(targetId);
    const filtrados = itens.filter((i: any) => i.place_id === pid);

    if (!filtrados.length) return `Sua lista em "${p.lugar}" está vazia.`;

    return `Lista ${p.lugar}:\n${filtrados
      .map((i: any) => `${i.done ? '✅' : '•'} ${i.item} [${i.category}]${i.project_id ? ' 📁' : ''}`)
      .join('\n')}`;
  } catch (err: any) {
    return `Erro ao carregar lista: ${err.message}`;
  }
}

export async function executeMarcarItemComprado(
  p: { item: string; lugar?: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = Number(numericUserId);
    const itens = await coreListarCompras(targetId);
    
    const itemAlvo = itens.find((i: any) => 
      i.item.toLowerCase() === p.item.trim().toLowerCase() && !i.done
    );

    if (!itemAlvo) return `O item "${p.item}" não foi encontrado na sua lista de pendentes.`;

    await coreAtualizarStatusCompra(targetId, itemAlvo.id, true);
    return `"${p.item}" marcado como comprado ✅`;
  } catch (err: any) {
    return `Erro ao atualizar: ${err.message}`;
  }
}

export async function executeListarComprasProjeto(
  p: { project_id: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = Number(numericUserId);
    const rid = await resolveProjectId(p.project_id, numericUserId);

    if (!rid) return `Projeto "${p.project_id}" não localizado.`;

    const itens = await coreListarCompras(targetId);
    const filtrados = itens.filter((i: any) => i.project_id === rid);

    if (!filtrados.length) return 'Nenhum item de compra vinculado a este projeto.';

    return filtrados
      .map((i: any) => `${i.done ? '✅' : '•'} ${i.item} [${i.category}]`)
      .join('\n');
  } catch (err: any) {
    return `Erro ao listar projeto: ${err.message}`;
  }
}
