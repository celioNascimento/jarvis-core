// lib/tools/executors/guidelines.ts
// Domínio: Diretrizes Dinâmicas (System Prompts)

import { supabase } from '@/lib/jarvis';

export async function executeGerenciarGuideline(p: any, authUserId: string, numericUserId: string): Promise<string> {
  const { acao, id, content, scope, active } = p;
  const numUserId = Number(numericUserId);

  if (acao === 'adicionar') {
    if (!content) return '[ERRO] O conteúdo (content) é obrigatório para adicionar uma diretriz.';
    
    const { data, error } = await supabase
      .schema('jarvis')
      .from('dynamic_guidelines')
      .insert({ 
        user_id: numUserId, 
        content, 
        scope: scope || 'personal', 
        active: true 
      })
      .select('id')
      .single();

    if (error) return `[ERRO] Falha ao adicionar diretriz: ${error.message}`;
    return `Guideline adicionada com sucesso! ID numérico: ${data.id}`;
  }

  if (acao === 'listar') {
    const { data, error } = await supabase
      .schema('jarvis')
      .from('dynamic_guidelines')
      .select('id, content, scope, active')
      .eq('user_id', numUserId)
      .order('id', { ascending: true });

    if (error) return `[ERRO] Falha ao listar diretrizes: ${error.message}`;
    if (!data?.length) return 'Nenhuma guideline cadastrada no momento.';

    return data
      .map(g => `ID: ${g.id} | Escopo: ${g.scope} | Status: ${g.active ? '🟢 Ativo' : '🔴 Inativo'}\nConteúdo: ${g.content}\n---`)
      .join('\n');
  }

  if (!id) return '[ERRO] O ID numérico da diretriz é obrigatório para editar, desativar ou remover.';

  if (acao === 'editar') {
    const updates: Record<string, any> = {};
    if (content !== undefined) updates.content = content;
    if (scope !== undefined) updates.scope = scope;
    if (active !== undefined) updates.active = active;

    const { error } = await supabase
      .schema('jarvis')
      .from('dynamic_guidelines')
      .update(updates)
      .eq('id', id)
      .eq('user_id', numUserId);

    if (error) return `[ERRO] Falha ao editar diretriz: ${error.message}`;
    return `Guideline ${id} atualizada com sucesso.`;
  }

  if (acao === 'remover') {
    const { error } = await supabase
      .schema('jarvis')
      .from('dynamic_guidelines')
      .delete()
      .eq('id', id)
      .eq('user_id', numUserId);

    if (error) return `[ERRO] Falha ao remover diretriz: ${error.message}`;
    return `Guideline ${id} deletada definitivamente do sistema.`;
  }

  return 'Ação não reconhecida para diretrizes.';
}
