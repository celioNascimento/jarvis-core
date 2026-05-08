// lib/tools/executors/memory.ts
// Domínio: Memória e Diretrizes
// Tools: buscar_memoria_longa, adicionar_diretriz_dinamica

import { supabase } from '@/lib/jarvis';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';

export async function executeBuscarMemoriaLonga(
  p: { query: string },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const emb = await getCachedEmbedding(p.query);
    const { data: mems, error } = await supabase.schema('jarvis').rpc('match_memories', {
      query_embedding: emb,
      match_threshold: 0.4,
      match_count: 5,
    });
    if (error) throw error;
    return (mems as any[])
      ?.filter(m => !m.summary.startsWith('[CINZA]'))
      .map(m => m.summary)
      .join('\n---\n') || 'Nenhuma memória relevante encontrada para esta busca.';
  } catch {
    return 'Erro ao acessar o banco de memórias semânticas.';
  }
}

export async function executeAdicionarDiretrizDinamica(
  p: { content: string; scope?: string },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const { error } = await supabase
      .schema('jarvis')
      .from('dynamic_guidelines')
      .insert({
        user_id: Number(numericUserId),
        content: p.content,
        scope:   p.scope || 'personal',
        active:  true,
      });
    if (error) throw error;
    return `Entendido. Diretriz aplicada: "${p.content}". Seguirei essa regra daqui em diante.`;
  } catch (err: any) {
    return `Erro técnico ao salvar diretriz: ${err.message}`;
  }
}