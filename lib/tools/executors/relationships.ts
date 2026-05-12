// lib/tools/executors/relationships.ts
// Domínio: Contatos, Relacionamentos e Permissões Compartilhadas

import { supabase } from '@/lib/jarvis';

// Helper para buscar o ID numérico do usuário alvo pelo email ou nome
async function resolveUserId(identifier: string): Promise<number | null> {
  if (!identifier) return null;
  if (/^\d+$/.test(identifier)) return Number(identifier);

  const { data, error } = await supabase
    .schema('jarvis')
    .from('users')
    .select('id')
    .or(`email.ilike.%${identifier}%,name.ilike.%${identifier}%`)
    .limit(1)
    .single();

  if (error || !data) return null;
  return data.id;
}

export async function executeAlternarPermissao(
  p: { contato: string; modulo: 'shopping_enabled' | 'projects_enabled'; habilitar: boolean },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  const { contato, modulo, habilitar } = p;
  const numUserId = Number(numericUserId);

  // 1. Resolve o ID do contato
  const targetId = await resolveUserId(contato);
  if (!targetId) {
    return `[ERRO] Não encontrei nenhum usuário chamado ou com email "${contato}".`;
  }

  // 2. Busca o relacionamento ativo entre os dois
  // Lembrete: Na sua tabela, a relação pode estar como (A=eu, B=ele) ou (A=ele, B=eu)
  const { data: rel, error: relError } = await supabase
    .schema('jarvis')
    .from('relationships')
    .select('id, settings')
    .eq('status', 'active')
    .or(`and(user_id_a.eq.${numUserId},user_id_b.eq.${targetId}),and(user_id_a.eq.${targetId},user_id_b.eq.${numUserId})`)
    .single();

  if (relError || !rel) {
    return `[ERRO] Você não possui um relacionamento ativo com "${contato}". O status atual pode ser pendente ou inativo.`;
  }

  // 3. Clona o JSONB atual ou cria um novo se estiver nulo
  const currentSettings = rel.settings || {};
  
  // Se a permissão já estiver no estado desejado, economiza a chamada de Update
  if (currentSettings[modulo] === habilitar) {
    return `A permissão para "${modulo}" com ${contato} já estava configurada como ${habilitar ? 'Ativa' : 'Inativa'}.`;
  }

  // Atualiza a chave específica
  const newSettings = { 
    ...currentSettings, 
    [modulo]: habilitar 
  };

  // 4. Salva no banco de dados
  const { error: updateError } = await supabase
    .schema('jarvis')
    .from('relationships')
    .update({ settings: newSettings })
    .eq('id', rel.id);

  if (updateError) {
    return `[ERRO] Falha ao atualizar permissões: ${updateError.message}`;
  }

  const moduloAcao = modulo === 'projects_enabled' ? 'Projetos' : 'Lista de Compras';
  const status = habilitar ? 'LIGADO 🟢' : 'DESLIGADO 🔴';

  return `Sucesso! O compartilhamento de **${moduloAcao}** com ${contato} foi ${status}.`;
}