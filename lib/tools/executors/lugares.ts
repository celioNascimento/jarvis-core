// lib/tools/executors/lugares.ts
// Domínio: Lugares e Listas de Compras
// Tools: salvar_lugar, adicionar_item_lista, ver_lista

import { supabase } from '@/lib/jarvis';

// ─── Helper: resolve place id por nome ───────────────────────────────────────

async function getPlaceId(nome: string, authUserId: string): Promise<string | null> {
  const { data } = await supabase
    .from('favorite_places')
    .select('id')
    .eq('user_id', authUserId)
    .ilike('name', nome.trim())
    .maybeSingle();
  return data?.id ?? null;
}

// ─── salvar_lugar ─────────────────────────────────────────────────────────────

export async function executeSalvarLugar(
  p: {
    nome: string;
    lat: number;
    lng: number;
    raio_metros: number;
    categoria: string;
  },
  authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    const { error } = await supabase
      .from('favorite_places')
      .upsert(
        {
          user_id:       authUserId,
          name:          p.nome.trim(),
          lat:           p.lat,
          lng:           p.lng,
          radius_meters: p.raio_metros,
          category:      p.categoria.trim(),
        },
        { onConflict: 'user_id,name' }
      );

    return error
      ? `Erro ao salvar lugar: ${error.message}`
      : `Lugar "${p.nome}" salvo nos seus favoritos.`;
  } catch (err: any) {
    return `Erro: ${err.message}`;
  }
}

// ─── adicionar_item_lista ─────────────────────────────────────────────────────

export async function executeAdicionarItemLista(
  p: { item: string; lugar: string },
  authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    const pid = await getPlaceId(p.lugar, authUserId);
    if (!pid) return `Não encontrei o lugar "${p.lugar}".`;

    await supabase
      .from('shopping_items')
      .upsert(
        { user_id: authUserId, item: p.item.trim(), place_id: pid, done: false },
        { onConflict: 'user_id,item,place_id' }
      );

    return `"${p.item}" adicionado à lista de ${p.lugar}.`;
  } catch (err: any) {
    return `Erro ao adicionar: ${err.message}`;
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
      .select('item, done')
      .eq('user_id', authUserId)
      .eq('place_id', pid)
      .order('done');

    if (!itens?.length) return `Sua lista de ${p.lugar} está vazia.`;

    return `Lista ${p.lugar}:\n${itens.map(i => `${i.done ? '✅' : '•'} ${i.item}`).join('\n')}`;
  } catch (err: any) {
    return `Erro ao carregar lista: ${err.message}`;
  }
}