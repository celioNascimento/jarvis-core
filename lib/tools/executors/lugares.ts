// lib/tools/executors/lugares.ts
// Domínio: Lugares Favoritos
// Tools: salvar_lugar
//
// Compras foram movidas para executors/compras.ts

import { supabase } from '@/lib/jarvis';
import { invalidateContextField } from '@/lib/services/context-cache';

// ─── Helper exportado — usado também em compras.ts ───────────────────────────

export async function getPlaceId(nome: string, authUserId: string): Promise<string | null> {
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
  numericUserId: string  // ← remover o underscore
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

    if (error) return `Erro ao salvar lugar: ${error.message}`;

    // APÓS confirmar sem erro, com campo e userId corretos
    await invalidateContextField(parseInt(numericUserId, 10), 'favorite_places');

    return `Lugar "${p.nome}" salvo nos seus favoritos.`;
  } catch (err: any) {
    return `Erro: ${err.message}`;
  }
}
