// lib/tools/executors/compras.ts

import { supabase } from '@/lib/jarvis';
import { getPlaceId } from './lugares';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const isUUID = (str: string) => 
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);

/**
 * Resolve o ID de usuário que deve ser usado para persistência.
 * Prioriza o mapeamento na tabela 'relationships' (Alias).
 */
async function resolveEffectiveUserId(authUserId: string, fallbackNumericId: string): Promise<string> {
  const { data, error } = await supabase
    .schema('jarvis')
    .from('relationships')
    .select('user_id_b')
    .eq('user_id_a', authUserId)
    .eq('status', 'active')
    .single();

  // Se houver um mapeamento (Alias), retorna o ID numérico vinculado.
  // Caso contrário, usa o fallback que vem do contexto da sessão.
  if (data?.user_id_b) return data.user_id_b;
  return fallbackNumericId;
}

async function resolveProjectId(identifier: string, targetUserId: string): Promise<string | null> {
  if (!identifier) return null;
  if (isUUID(identifier)) return identifier;

  const { data, error } = await supabase
    .schema('jarvis')
    .from('projects')
    .select('id')
    .eq('user_id', targetUserId) // Busca projetos do usuário "alvo"
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
    lugar?: string;
    category?: string;
    project_id?: string;
  },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    // RESOLUÇÃO DE IDENTIDADE: Aqui garantimos que o ID seja o 8595482774
    const effectiveId = await resolveEffectiveUserId(authUserId, numericUserId);

    let pid: string | null = null;
    if (p.lugar) {
      pid = await getPlaceId(p.lugar, authUserId);
    }

    let resolvedProjectId: string | null = null;
    if (p.project_id) {
      resolvedProjectId = await resolveProjectId(p.project_id, effectiveId);
      if (!resolvedProjectId) return `Não encontrei o projeto "${p.project_id}".`;
    }

    const payload = {
      user_id:    effectiveId, // AGORA USA O ID CERTO
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

    if (error) return `Erro ao adicionar: ${error.message}`;

    return `"${p.item}" adicionado com sucesso! (ID Destino: ${effectiveId})`;
  } catch (err: any) {
    return `Erro: ${err.message}`;
  }
}

// Nota: Aplique a mesma lógica de 'effectiveId' nas funções executeVerLista e executeMarcarItemComprado
