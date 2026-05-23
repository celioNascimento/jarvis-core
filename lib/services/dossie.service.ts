import { supabase } from '@/lib/jarvis';
import { indexL3Chunks } from '@/lib/chat/l3-chunks';

export async function updateDossie(
  userId: number,
  dossie: string
): Promise<{ indexed: number; themes: string[] }> {
  const { error } = await supabase
    .from('users')
    .update({ current_context: dossie })
    .eq('id', userId);

  if (error) throw new Error(`[DossieService] Falha ao salvar: ${error.message}`);

  const result = await indexL3Chunks(userId, dossie);
  console.log(`[DossieService] Atualizado: ${result.themes.join(', ')}`);
  return result;
}

export async function getDossie(userId: number): Promise<string> {
  const { data, error } = await supabase
    .from('users')
    .select('current_context')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(`[DossieService] Falha ao buscar: ${error.message}`);
  return data?.current_context || '';
}