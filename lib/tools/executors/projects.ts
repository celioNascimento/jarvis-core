// lib/tools/executors/projects.ts
// V12.0.0 — Arquitetura Centralizada (Resolution & Identity)

import { supabase } from '@/lib/jarvis';
import { 
  getEffectiveUserId, 
  resolveUser, 
  resolveProject, 
  formatDisplayName 
} from '@/lib/modules/relationships';

// ─── PROJETOS ─────────────────────────────────────────────────────────────────

/**
 * Cria, atualiza ou altera o status de um projeto.
 */
export async function executeGerenciarProjeto(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { acao, tag, name, description, status, url, repo_url, cover_url } = p;

    if (acao === 'criar') {
      const { data, error } = await supabase
        .from('projects')
        .insert({
          user_id: Number(targetId),
          tag,
          name,
          description,
          status: status || 'em_desenvolvimento',
          url,
          repo_url,
          cover_url,
        })
        .select().single();

      if (error) throw error;
      return `Projeto "${data.name || data.tag}" criado com sucesso.`;
    }

    // Resolução centralizada para ações de atualização
    const project = await resolveProject(p.project_id, targetId);
    if (!project) return `Não encontrei o projeto "${p.project_id}".`;

    const updates: any = { name, description, url, repo_url, cover_url };
    if (status) updates.status = status;
    if (acao === 'arquivar') updates.status = 'em_pausa';
    if (acao === 'reativar') updates.status = 'em_desenvolvimento';
    if (acao === 'concluir') updates.status = 'concluido';
    if (acao === 'cancelar') updates.status = 'cancelado';

    const { error } = await supabase.from('projects').update(updates).eq('id', project.id);
    if (error) throw error;

    return `Projeto "${project.name || project.tag}" atualizado para: ${acao === 'atualizar' ? updates.status || project.status : acao}.`;
  } catch (err: any) { return `Erro ao gerenciar projeto: ${err.message}`; }
}

/**
 * Lista os projetos do usuário.
 */
export async function executeListarProjetos(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    let query = supabase.from('projects').select('*').eq('user_id', Number(targetId));
    
    if (p.status) query = query.eq('status', p.status);

    const { data, error } = await query.order('updated_at', { ascending: false });
    if (error) throw error;
    if (!data?.length) return 'Nenhum projeto encontrado.';

    return data.map(pj => `• [${pj.status.toUpperCase()}] ${pj.name || pj.tag} (ID: ${pj.id})`).join('\n');
  } catch (err: any) { return `Erro ao listar: ${err.message}`; }
}

// ─── TÓPICOS ──────────────────────────────────────────────────────────────────

/**
 * Gerencia a estrutura de tópicos (hierárquica).
 */
export async function executeGerenciarTopico(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { acao, topic_id, parent_id, tag, name, description, order_index } = p;

    const project = await resolveProject(p.project_id, targetId);
    if (!project) return `Projeto "${p.project_id}" não encontrado.`;

    if (acao === 'criar') {
      const { data, error } = await supabase
        .from('project_topics')
        .insert({ project_id: project.id, parent_id, tag, name, description, order_index: order_index || 0 })
        .select().single();
      if (error) throw error;
      return `Tópico "${data.name || data.tag}" criado em ${project.name}.`;
    }

    if (!topic_id) return 'ID do tópico é necessário para esta ação.';

    if (acao === 'atualizar') {
      const { error } = await supabase.from('project_topics').update({ parent_id, tag, name, description, order_index }).eq('id', topic_id);
      if (error) throw error;
      return 'Tópico atualizado.';
    }

    if (acao === 'remover') {
      const { error } = await supabase.from('project_topics').delete().eq('id', topic_id);
      if (error) throw error;
      return 'Tópico removido com sucesso.';
    }
    return 'Ação não reconhecida.';
  } catch (err: any) { return `Erro nos tópicos: ${err.message}`; }
}

/**
 * Lista tópicos de um projeto.
 */
export async function executeListarTopicos(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const project = await resolveProject(p.project_id, targetId);
    if (!project) return 'Projeto não localizado.';

    let query = supabase.from('project_topics').select('*').eq('project_id', project.id);
    if (p.parent_id !== undefined) {
      query = p.parent_id === null ? query.is('parent_id', null) : query.eq('parent_id', p.parent_id);
    }

    const { data, error } = await query.order('order_index', { ascending: true });
    if (error) throw error;
    return data?.map(t => `- ${t.name || t.tag} (ID: ${t.id})`).join('\n') || 'Sem tópicos.';
  } catch (err: any) { return `Erro: ${err.message}`; }
}

// ─── ENTRIES (NOTAS/IDEIAS) ───────────────────────────────────────────────────

/**
 * Registra ou remove entries (conteúdo real).
 */
export async function executeGerenciarEntry(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { acao, topic_id, entry_id, type, title, body, status, order_index, metadata } = p;

    if (acao === 'criar') {
      const { data, error } = await supabase
        .from('project_entries')
        .insert({ topic_id, type: type || 'note', title, body, status: status || 'open', order_index: order_index || 0, created_by: Number(targetId), metadata: metadata || {} })
        .select('id').single();
      if (error) throw error;
      return `Entry registrada (ID: ${data.id}).`;
    }

    if (acao === 'atualizar') {
      const { error } = await supabase.from('project_entries').update({ type, title, body, status, order_index, metadata }).eq('id', entry_id);
      if (error) throw error;
      return 'Entry atualizada.';
    }

    if (acao === 'remover') {
      const { error } = await supabase.from('project_entries').delete().eq('id', entry_id);
      if (error) throw error;
      return 'Entry removida.';
    }
    return 'Ação inválida.';
  } catch (err: any) { return `Erro nas entries: ${err.message}`; }
}

/**
 * Lista as entries de um tópico.
 */
export async function executeListarEntries(p: any, _authUserId: string, _numericUserId: string): Promise<string> {
  try {
    let query = supabase.from('project_entries').select('*').eq('topic_id', p.topic_id);
    if (p.type) query = query.eq('type', p.type);
    if (p.status) query = query.eq('status', p.status);

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    return data?.map(e => `[${e.type.toUpperCase()}] ${e.title || 'Sem título'} (ID: ${e.id})`).join('\n') || 'Nenhuma entry.';
  } catch (err: any) { return `Erro: ${err.message}`; }
}

// ─── MEMBROS (COMPARTILHAMENTO) ───────────────────────────────────────────────

/**
 * Gerencia quem tem acesso ao projeto.
 */
export async function executeGerenciarMembrosProjeto(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { acao, project_id, user_identifier, role } = p;

    const project = await resolveProject(project_id, targetId);
    if (!project) return `Projeto "${project_id}" não encontrado.`;

    if (acao === 'listar') {
      const { data, error } = await supabase
        .from('project_members')
        .select('role, status, users ( name, preferred_name, nickname, email )')
        .eq('project_id', project.id);
      
      if (error) throw error;
      return data.map(m => {
        const u: any = Array.isArray(m.users) ? m.users[0] : m.users;
        return `- ${formatDisplayName(u)} | Papel: ${m.role} | Status: ${m.status}`;
      }).join('\n');
    }

    // Resolução universal de usuário para convites/alterações
    const targetUser = await resolveUser(user_identifier);
    if (!targetUser) return `Não encontrei ninguém com o identificador "${user_identifier}".`;

    if (acao === 'adicionar') {
      const { error } = await supabase.from('project_members').insert({ project_id: project.id, user_id: targetUser.id, invited_by: Number(targetId), role: role || 'viewer', status: 'pending' });
      if (error) return error.code === '23505' ? `${formatDisplayName(targetUser)} já está no projeto.` : `Erro: ${error.message}`;
      return `Convite enviado para ${formatDisplayName(targetUser)}.`;
    }

    if (acao === 'atualizar') {
      const { error } = await supabase.from('project_members').update({ role }).eq('project_id', project.id).eq('user_id', targetUser.id);
      if (error) throw error;
      return `Papel de ${formatDisplayName(targetUser)} atualizado para ${role}.`;
    }

    if (acao === 'remover') {
      const { error } = await supabase.from('project_members').delete().eq('project_id', project.id).eq('user_id', targetUser.id);
      if (error) throw error;
      return `Acesso de ${formatDisplayName(targetUser)} removido.`;
    }
    return 'Ação de membros inválida.';
  } catch (err: any) { return `Erro no compartilhamento: ${err.message}`; }
}