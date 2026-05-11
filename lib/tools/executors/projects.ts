import { supabase } from '@/lib/jarvis';

/**
 * PROJETOS: CRUD e Listagem
 */
export async function executeGerenciarProjeto(p: any, authUserId: string, numericUserId: string) {
  const { acao, project_id, tag, name, description, status, url, repo_url, cover_url } = p;

  if (acao === 'criar') {
    const { data, error } = await supabase
      .schema('jarvis')
      .from('projects')
      .insert({
        user_id: numericUserId,
        tag,
        name,
        description,
        status: status || 'em_desenvolvimento',
        url,
        repo_url,
        cover_url
      })
      .select()
      .single();

    if (error) return `[ERRO] Falha ao criar projeto: ${error.message}`;
    return `Projeto "${data.name || data.tag}" criado com sucesso! ID: ${data.id}`;
  }

  if (!project_id) return "[ERRO] ID do projeto é obrigatório para atualizar ou arquivar.";

  if (acao === 'atualizar') {
    const { error } = await supabase
      .schema('jarvis')
      .from('projects')
      .update({ name, description, status, url, repo_url, cover_url })
      .eq('id', project_id)
      .eq('user_id', numericUserId);

    if (error) return `[ERRO] Falha ao atualizar: ${error.message}`;
    return "Projeto atualizado com sucesso.";
  }

  if (acao === 'arquivar') {
    const { error } = await supabase
      .schema('jarvis')
      .from('projects')
      .update({ status: 'em_pausa' })
      .eq('id', project_id)
      .eq('user_id', numericUserId);

    if (error) return `[ERRO] Falha ao arquivar: ${error.message}`;
    return "Projeto arquivado (status: em_pausa).";
  }

  return "Ação não reconhecida para projetos.";
}

export async function executeListarProjetos(p: any, authUserId: string, numericUserId: string) {
  let query = supabase.schema('jarvis').from('projects').select('*').eq('user_id', numericUserId);
  if (p.status) query = query.eq('status', p.status);

  const { data, error } = await query.order('updated_at', { ascending: false });
  if (error) return `[ERRO] Falha ao listar: ${error.message}`;
  if (!data?.length) return "Nenhum projeto encontrado.";

  return data.map(pj => `- [${pj.tag}] ${pj.name || 'Sem nome'}: ${pj.status} (ID: ${pj.id})`).join('\n');
}

/**
 * TÓPICOS: Estrutura hierárquica
 */
export async function executeGerenciarTopico(p: any, authUserId: string, numericUserId: string) {
  const { acao, project_id, topic_id, parent_id, tag, name, description, order_index } = p;

  if (acao === 'criar') {
    const { data, error } = await supabase
      .schema('jarvis')
      .from('project_topics')
      .insert({ project_id, parent_id, tag, name, description, order_index: order_index || 0 })
      .select()
      .single();
    if (error) return `[ERRO] Falha ao criar tópico: ${error.message}`;
    return `Tópico "${data.tag}" criado no projeto.`;
  }

  if (!topic_id) return "[ERRO] ID do tópico é obrigatório para atualizar ou remover.";

  if (acao === 'atualizar') {
    const { error } = await supabase
      .schema('jarvis')
      .from('project_topics')
      .update({ parent_id, tag, name, description, order_index })
      .eq('id', topic_id)
      .eq('project_id', project_id);
    
    if (error) return `[ERRO] Falha ao atualizar tópico: ${error.message}`;
    return "Tópico atualizado com sucesso.";
  }

  if (acao === 'remover') {
    const { error } = await supabase
      .schema('jarvis')
      .from('project_topics')
      .delete()
      .eq('id', topic_id)
      .eq('project_id', project_id);
    
    if (error) return `[ERRO] Falha ao remover tópico: ${error.message}`;
    return "Tópico removido.";
  }

  return "Ação não reconhecida para tópicos.";
}

export async function executeListarTopicos(p: any) {
  let query = supabase.schema('jarvis').from('project_topics').select('*').eq('project_id', p.project_id);
  
  if (p.parent_id !== undefined) {
    query = p.parent_id === null ? query.is('parent_id', null) : query.eq('parent_id', p.parent_id);
  }

  const { data, error } = await query.order('order_index', { ascending: true });
  if (error) return `[ERRO] Falha ao listar tópicos: ${error.message}`;
  if (!data?.length) return "Nenhum tópico encontrado.";

  return data.map(t => `ID: ${t.id} | Tag: ${t.tag} | Nome: ${t.name}`).join('\n');
}

/**
 * ENTRIES: Notas, Decisões, Débitos Técnicos
 */
export async function executeGerenciarEntry(p: any, authUserId: string, numericUserId: string) {
  const { acao, project_id, topic_id, entry_id, type, title, body, status, order_index, metadata } = p;

  if (acao === 'criar') {
    const { error } = await supabase
      .schema('jarvis')
      .from('project_entries')
      .insert({ 
        topic_id, 
        type: type || 'note', 
        title, 
        body, 
        status: status || 'open', 
        order_index: order_index || 0,
        created_by: numericUserId, 
        metadata: metadata || {} 
      });
    
    if (error) return `[ERRO] Falha ao criar entry: ${error.message}`;
    return "Entry registrada com sucesso.";
  }

  if (!entry_id) return "[ERRO] ID da entry é obrigatório para atualizar ou remover.";

  if (acao === 'atualizar') {
    const { error } = await supabase
      .schema('jarvis')
      .from('project_entries')
      .update({ type, title, body, status, order_index, metadata })
      .eq('id', entry_id)
      .eq('topic_id', topic_id);
      
    if (error) return `[ERRO] Falha ao atualizar entry: ${error.message}`;
    return "Entry atualizada com sucesso.";
  }

  if (acao === 'remover') {
    const { error } = await supabase
      .schema('jarvis')
      .from('project_entries')
      .delete()
      .eq('id', entry_id)
      .eq('topic_id', topic_id);
      
    if (error) return `[ERRO] Falha ao remover entry: ${error.message}`;
    return "Entry removida.";
  }

  return "Ação não reconhecida para entries.";
}

export async function executeListarEntries(p: any) {
  let query = supabase.schema('jarvis').from('project_entries').select('*').eq('topic_id', p.topic_id);
  
  if (p.type) query = query.eq('type', p.type);
  if (p.status) query = query.eq('status', p.status);

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return `[ERRO] Falha ao listar entries: ${error.message}`;
  if (!data?.length) return "Nenhuma entry neste tópico.";

  return data.map(e => `[${e.type.toUpperCase()}] ${e.title || 'Sem título'}: ${e.status}`).join('\n');
}
