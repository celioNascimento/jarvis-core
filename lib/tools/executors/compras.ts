    // lib/tools/executors/compras.ts
// Domínio: Lista de Compras
// Tools: adicionar_item_lista, ver_lista, marcar_item_comprado, listar_compras_projeto
//
// Separado de lugares.ts — domínios distintos.
// project_id é opcional: itens sem projeto são pessoais (ex: supermercado).

import { supabase } from '@/lib/jarvis';
import { getPlaceId } from './lugares';

// ─── HELPER ───────────────────────────────────────────────────────────────────

const isUUID = (str: string) => 
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);

async function resolveProjectId(identifier: string, numericUserId: string): Promise<string | null> {
  if (!identifier) return null;
  if (isUUID(identifier)) return identifier;

  const { data, error } = await supabase
    .schema('jarvis')
    .from('projects')
    .select('id')
    .eq('user_id', numericUserId)
    .or(`tag.eq.${identifier},name.ilike.%${identifier}%`)
    .limit(1)
    .single();

  if (error || !data) return null;
  return data.id;
}

// ─── adicionar_item_lista ─────────────────────────────────────────────────────

export async function executeAdicionarItemLista(
  p: {
    item: string;
    lugar?: string;         // opcional — pode adicionar sem lugar fixo
    category?: string;      // mercado | higiene | farmacia | reforma | casa | roupas | tecnologia | outros
    project_id?: string;    // opcional — vincula ao projeto
  },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    let pid: string | null = null;

    if (p.lugar) {
      pid = await getPlaceId(p.lugar, authUserId);
      if (!pid) return `Não encontrei o lugar "${p.lugar}". Salve-o primeiro com "salvar_lugar".`;
    }

    let resolvedProjectId: string | null = null;
    if (p.project_id) {
      resolvedProjectId = await resolveProjectId(p.project_id, numericUserId);
      if (!resolvedProjectId) {
        return `Não encontrei nenhum projeto chamado "${p.project_id}".`;
      }
    }

    const payload: Record<string, any> = {
      user_id:    authUserId,
      item:       p.item.trim(),
      place_id:   pid,
      done:       false,
      archived:   false,
      category:   p.category ?? 'outros',
      project_id: resolvedProjectId,
    };

    const { error } = await supabase
      .from('shopping_items')
      .upsert(payload, { onConflict: 'user_id,item,place_id' });

    if (error) return `Erro ao adicionar item: ${error.message}`;

    const onde = p.lugar ? ` para ${p.lugar}` : '';
    const projeto = resolvedProjectId ? ' (vinculado ao projeto)' : '';
    return `"${p.item}" adicionado à lista${onde}${projeto}.`;
  } catch (err: any) {
    return `Erro: ${err.message}`;
  }
}

// ─── ver_lista ────────────────────────────────────────────────────────────────

export async function executeVerLista(
  p: { lugar: string },
  authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    const pid = await getPlaceId(p.lugar, authUserId);
    if (!pid) return `Lista de ${p.lugar} não encontrada.`;

    const { data: itens } = await supabase
      .from('shopping_items')
      .select('item, done, category, project_id')
      .eq('user_id', authUserId)
      .eq('place_id', pid)
      .eq('archived', false)
      .order('done');

    if (!itens?.length) return `Sua lista de ${p.lugar} está vazia.`;

    return `Lista ${p.lugar}:\n${itens
      .map(i => {
        const proj = i.project_id ? ' 📁' : '';
        return `${i.done ? '✅' : '•'} ${i.item} [${i.category}]${proj}`;
      })
      .join('\n')}`;
  } catch (err: any) {
    return `Erro ao carregar lista: ${err.message}`;
  }
}

// ─── marcar_item_comprado ─────────────────────────────────────────────────────

export async function executeMarcarItemComprado(
  p: { item: string; lugar?: string },
  authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    let query = supabase
      .from('shopping_items')
      .update({ done: true })
      .eq('user_id', authUserId)
      .ilike('item', p.item.trim());

    if (p.lugar) {
      const pid = await getPlaceId(p.lugar, authUserId);
      if (pid) query = query.eq('place_id', pid);
    }

    const { error } = await query;
    return error
      ? `Erro ao marcar item: ${error.message}`
      : `"${p.item}" marcado como comprado ✅`;
  } catch (err: any) {
    return `Erro: ${err.message}`;
  }
}

// ─── listar_compras_projeto ───────────────────────────────────────────────────
// Retorna todos os itens pendentes vinculados a um projeto específico.

export async function executeListarComprasProjeto(
  p: { project_id: string },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const resolvedProjectId = await resolveProjectId(p.project_id, numericUserId);
    if (!resolvedProjectId) return `Não encontrei o projeto "${p.project_id}".`;

    const { data, error } = await supabase
      .from('shopping_items')
      .select('item, category, done, place_id')
      .eq('user_id', authUserId)
      .eq('project_id', resolvedProjectId)
      .eq('archived', false)
      .order('done')
      .order('category');

    if (error) return `Erro ao buscar compras do projeto: ${error.message}`;
    if (!data?.length) return 'Nenhum item de compra vinculado a este projeto.';

    const pendentes = data.filter(i => !i.done);
    const comprados = data.filter(i => i.done);

    const linhas: string[] = [];
    if (pendentes.length) {
      linhas.push('**Pendentes:**');
      linhas.push(...pendentes.map(i => `• ${i.item} [${i.category}]`));
    }
    if (comprados.length) {
      linhas.push('\n**Comprados:**');
      linhas.push(...comprados.map(i => `✅ ${i.item}`));
    }

    return linhas.join('\n');
  } catch (err: any) {
    return `Erro: ${err.message}`;
  }
}
