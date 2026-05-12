// lib/tools/executors/projects.ts
// Domínio: Projetos, Tópicos e Entries
// V2 — ações reativar, concluir e cancelar adicionadas em gerenciar_projeto
// V3 — helper resolveProjectId adicionado para permitir busca por nome/tag

import { supabase } from '@/lib/jarvis';

// Helper para identificar se a string já é um UUID válido
const isUUID = (str: string) => 
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);

// Helper para buscar o UUID caso a IA envie apenas o nome ou tag do projeto
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

// ─── PROJETOS ─────────────────────────────────────────────────────────────────

export async function executeGerenciarProjeto(p: any, authUserId: string, numericUserId: string): Promise<string> {
  const { acao, tag, name, description, status, url, repo_url, cover_url } = p;

  // ── criar ──────────────────────────────────────────────────────────────────
  if (acao === 'criar') {
    const { data, error } = await supabase
      .schema('jarvis')
      .from('projects')
      .insert({
        user_id:     numericUserId,
        tag,
        name,
        description,
        status:      status || 'em_desenvolvimento',
        url,
        repo_url,
        cover_url,
      })
      .select()
      .single();

    if (error) return `[ERRO] Falha ao criar projeto: ${error.message}`;
    return `Projeto "${data.name || data.tag}" criado com sucesso! ID: ${data.id}`;
  }

  // Todas as ações abaixo exigem project_id resolvido
  const resolvedProjectId = await resolveProjectId(p.project_id, numericUserId);
  if (!resolvedProjectId) return `[ERRO] ID ou Nome do projeto "${p.project_id}" é obrigatório ou não foi encontrado para esta ação.`;

  // ── atualizar ──────────────────────────────────────────────────────────────
  if (acao === 'atualizar') {
    const { error } = await supabase
      .schema('jarvis')
      .from('projects')
      .update({ name, description, status, url, repo_url, cover_url })
      .eq('id', resolvedProjectId)
      .eq('user_id', numericUserId);

    if (error) return `[ERRO] Falha ao atualizar: ${error.message}`;
    return 'Projeto atualizado com sucesso.';
  }

  // ── arquivar → em_pausa (reversível) ──────────────────────────────────────
  if (acao === 'arquivar') {
    const { error } = await supabase
      .schema('jarvis')
      .from('projects')
      .update({ status: 'em_pausa' })
      .eq('id', resolvedProjectId)
      .eq('user_id', numericUserId);

    if (error) return `[ERRO] Falha ao arquivar: ${error.message}`;
    return 'Projeto pausado. Os itens de compra vinculados permanecem ativos.';
  }

  // ── reativar → em_desenvolvimento ─────────────────────────────────────────
  if (acao === 'reativar') {
    const { error } = await supabase
      .schema('jarvis')
      .from('projects')
      .update({ status: 'em_desenvolvimento' })
      .eq('id', resolvedProjectId)
      .eq('user_id', numericUserId);

    if (error) return `[ERRO] Falha ao reativar: ${error.message}`;
    return 'Projeto reativado e em desenvolvimento novamente.';
  }

  // ── concluir → concluido (trigger arquiva shopping_items) ─────────────────
  if (acao === 'concluir') {
    const { error } = await supabase
      .schema('jarvis')
      .from('projects')
      .update({ status: 'concluido' })
      .eq('id', resolvedProjectId)
      .eq('user_id', numericUserId);

    if (error) return `[ERRO] Falha ao concluir: ${error.message}`;
    return 'Projeto marcado como concluído. Itens de compra vinculados foram arquivados automaticamente.';
  }

  // ── cancelar → cancelado (trigger arquiva shopping_items) ─────────────────
  if (acao === 'cancelar') {
    const { error } = await supabase
      .schema('jarvis')
      .from('projects')
      .update({ status: 'cancelado' })
      .eq('id', resolvedProjectId)
      .eq('user_id', numericUserId);

    if (error) return `[ERRO] Falha ao cancelar: ${error.message}`;
    return 'Projeto cancelado. Itens de compra vinculados foram arquivados automaticamente.';
  }

  return 'Ação não reconhecida para projetos.';
}

export async function executeListarProjetos(p: any, authUserId: string, numericUserId: string): Promise<string> {
  let query = supabase
    .schema('jarvis')
    .from('projects')
    .select('*')
    .eq('user_id', numericUserId);

  if (p.status) query = query.eq('status', p.status);

  const { data, error } = await query.order('updated_at', { ascending: false });
  if (error) return `[ERRO] Falha ao listar: ${error.message}`;
  if (!data?.length) return 'Nenhum projeto encontrado.';

  const statusIcon: Record<string, string> = {
    em_desenvolvimento: '🟢',
    em_pausa:           '⏸️',
    concluido:          '✅',
    cancelado:          '❌',
  };

  return data
    .map(pj => `${statusIcon[pj.status] ?? '•'} [${pj.tag}] ${pj.name || 'Sem nome'} — ${pj.status} (ID: ${pj.id})`)
    .join('\n');
}

// ─── TÓPICOS ──────────────────────────────────────────────────────────────────

export async function executeGerenciarTopico(p: any, authUserId: string, numericUserId: string): Promise<string> {
  const { acao, topic_id, parent_id, tag, name, description, order_index } = p;

  const resolvedProjectId = await resolveProjectId(p.project_id, numericUserId);
  if (!resolvedProjectId) return `[ERRO] Não encontrei nenhum projeto chamado ou com ID "${p.project_id}".`;

  if (acao === 'criar') {
    const { data, error } = await supabase
      .schema('jarvis')
      .from('project_topics')
      .insert({ project_id: resolvedProjectId, parent_id, tag, name, description, order_index: order_index || 0 })
      .select()
      .single();

    if (error) return `[ERRO] Falha ao criar tópico: ${error.message}`;
    return `Tópico "${data.tag}" criado no projeto. ID: ${data.id}`;
  }

  if (!topic_id) return '[ERRO] ID do tópico é obrigatório para atualizar ou remover.';

  if (acao === 'atualizar') {
    const { error } = await supabase
      .schema('jarvis')
      .from('project_topics')
      .update({ parent_id, tag, name, description, order_index })
      .eq('id', topic_id)
      .eq('project_id', resolvedProjectId);

    if (error) return `[ERRO] Falha ao atualizar tópico: ${error.message}`;
    return 'Tópico atualizado com sucesso.';
  }

  if (acao === 'remover') {
    const { error } = await supabase
      .schema('jarvis')
      .from('project_topics')
      .delete()
      .eq('id', topic_id)
      .eq('project_id', resolvedProjectId);

    if (error) return `[ERRO] Falha ao remover tópico: ${error.message}`;
    return 'Tópico removido. Subtópicos e entries vinculados foram removidos em cascata.';
  }

  return 'Ação não reconhecida para tópicos.';
}

export async function executeListarTopicos(p: any, authUserId: string, numericUserId: string): Promise<string> {
  const resolvedProjectId = await resolveProjectId(p.project_id, numericUserId);
  if (!resolvedProjectId) return `[ERRO] Não encontrei nenhum projeto chamado ou com ID "${p.project_id}".`;

  let query = supabase
    .schema('jarvis')
    .from('project_topics')
    .select('*')
    .eq('project_id', resolvedProjectId);

  if (p.parent_id !== undefined) {
    query = p.parent_id === null
      ? query.is('parent_id', null)
      : query.eq('parent_id', p.parent_id);
  }

  const { data, error } = await query.order('order_index', { ascending: true });
  if (error) return `[ERRO] Falha ao listar tópicos: ${error.message}`;
  if (!data?.length) return 'Nenhum tópico encontrado.';

  return data
    .map(t => `ID: ${t.id} | Tag: ${t.tag} | Nome: ${t.name || '—'} | Pai: ${t.parent_id || 'raiz'}`)
    .join('\n');
}

// ─── ENTRIES ──────────────────────────────────────────────────────────────────

export async function executeGerenciarEntry(p: any, authUserId: string, numericUserId: string): Promise<string> {
  const { acao, topic_id, entry_id, type, title, body, status, order_index, metadata } = p;

  if (acao === 'criar') {
    const { data, error } = await supabase
      .schema('jarvis')
      .from('project_entries')
      .insert({
        topic_id,
        type:        type || 'note',
        title,
        body,
        status:      status || 'open',
        order_index: order_index || 0,
        created_by:  numericUserId,
        metadata:    metadata || {},
      })
      .select('id')
      .single();

    if (error) return `[ERRO] Falha ao criar entry: ${error.message}`;
    return `Entry registrada com sucesso. ID: ${data.id}`;
  }

  if (!entry_id) return '[ERRO] ID da entry é obrigatório para atualizar ou remover.';

  if (acao === 'atualizar') {
    const { error } = await supabase
      .schema('jarvis')
      .from('project_entries')
      .update({ type, title, body, status, order_index, metadata })
      .eq('id', entry_id)
      .eq('topic_id', topic_id);

    if (error) return `[ERRO] Falha ao atualizar entry: ${error.message}`;
    return 'Entry atualizada com sucesso.';
  }

  if (acao === 'remover') {
    const { error } = await supabase
      .schema('jarvis')
      .from('project_entries')
      .delete()
      .eq('id', entry_id)
      .eq('topic_id', topic_id);

    if (error) return `[ERRO] Falha ao remover entry: ${error.message}`;
    return 'Entry removida.';
  }

  return 'Ação não reconhecida para entries.';
}

export async function executeListarEntries(p: any): Promise<string> {
  let query = supabase
    .schema('jarvis')
    .from('project_entries')
    .select('*')
    .eq('topic_id', p.topic_id);

  if (p.type)   query = query.eq('type', p.type);
  if (p.status) query = query.eq('status', p.status);

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return `[ERRO] Falha ao listar entries: ${error.message}`;
  if (!data?.length) return 'Nenhuma entry neste tópico.';

  return data
    .map(e => `[${e.type.toUpperCase()}] ${e.title || 'Sem título'} — ${e.status} (ID: ${e.id})`)
    .join('\n');
}

export async function executeListarEntries(p: any, authUserId: string, numericUserId: string): Promise<string> {
  let query = supabase
    .schema('jarvis')
    .from('project_entries')
    .select('*')
    .eq('topic_id', p.topic_id);

  if (p.type)   query = query.eq('type', p.type);
  if (p.status) query = query.eq('status', p.status);

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return `[ERRO] Falha ao listar entries: ${error.message}`;
  if (!data?.length) return 'Nenhuma entry neste tópico.';

  return data
    .map(e => `[${e.type.toUpperCase()}] ${e.title || 'Sem título'} — ${e.status} (ID: ${e.id})`)
    .join('\n');
}

