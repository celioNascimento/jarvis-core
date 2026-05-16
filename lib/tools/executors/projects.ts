// lib/tools/executors/projects.ts
// V12.1.1 — Correção de Build (Parâmetros e Exports)

import { supabase } from '@/lib/jarvis';
import { 
  getEffectiveUserId, 
  resolveUser, 
  resolveProject, 
  formatDisplayName 
} from '@/lib/modules/relationships';
import { 
  coreListarMembrosProjeto, 
  coreAtualizarMembroProjeto 
} from '@/lib/services/projects.service';

// ─── PROJETOS ─────────────────────────────────────────────────────────────────

export async function executeGerenciarProjeto(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { acao, tag, name, description, status, url, repo_url, cover_url } = p;

    if (acao === 'criar') {
      const { data, error } = await supabase
        .schema('jarvis')
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
      
      await supabase.schema('jarvis').from('project_members').insert({
        project_id: data.id, user_id: Number(targetId), invited_by: Number(targetId), role: 'owner', status: 'active'
      });
      
      return `Projeto "${data.name || data.tag}" criado com sucesso.`;
    }

    const project = await resolveProject(p.project_id, targetId);
    if (!project) return `Não encontrei o projeto "${p.project_id}".`;

    const updates: any = { name, description, url, repo_url, cover_url };
    if (status) updates.status = status;
    if (acao === 'arquivar') updates.status = 'em_pausa';
    if (acao === 'reativar') updates.status = 'em_desenvolvimento';
    if (acao === 'concluir') updates.status = 'concluido';
    if (acao === 'cancelar') updates.status = 'cancelado';

    const { error } = await supabase.schema('jarvis').from('projects').update(updates).eq('id', project.id);
    if (error) throw error;

    return `Projeto "${project.name || project.tag}" atualizado.`;
  } catch (err: any) { return `Erro ao gerenciar projeto: ${err.message}`; }
}

export async function executeListarProjetos(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    let query = supabase.schema('jarvis').from('projects').select('*').eq('user_id', Number(targetId));
    if (p.status) query = query.eq('status', p.status);

    const { data, error } = await query.order('updated_at', { ascending: false });
    if (error) throw error;
    if (!data?.length) return 'Nenhum projeto encontrado.';

    return data.map(pj => `• [${pj.status.toUpperCase()}] ${pj.name || pj.tag} (ID: ${pj.id})`).join('\n');
  } catch (err: any) { return `Erro ao listar: ${err.message}`; }
}

// ─── TÓPICOS ──────────────────────────────────────────────────────────────────

export async function executeGerenciarTopico(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { acao, topic_id, parent_id, tag, name, description, order_index } = p;

    const project = await resolveProject(p.project_id, targetId);
    if (!project) return `Projeto não encontrado.`;

    if (acao === 'criar') {
      const { data, error } = await supabase.schema('jarvis').from('project_topics').insert({ project_id: project.id, parent_id, tag, name, description, order_index: order_index || 0 }).select().single();
      if (error) throw error;
      return `Tópico "${data.name || data.tag}" criado.`;
    }
    if (!topic_id) return 'ID necessário.';
    if (acao === 'atualizar') {
      const { error } = await supabase.schema('jarvis').from('project_topics').update({ parent_id, tag, name, description, order_index }).eq('id', topic_id);
      if (error) throw error; return 'Atualizado.';
    }
    if (acao === 'remover') {
      const { error } = await supabase.schema('jarvis').from('project_topics').delete().eq('id', topic_id);
      if (error) throw error; return 'Removido.';
    }
    return 'Ação não reconhecida.';
  } catch (err: any) { return `Erro: ${err.message}`; }
}

export async function executeListarTopicos(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const project = await resolveProject(p.project_id, targetId);
    if (!project) return 'Projeto não localizado.';

    let query = supabase.schema('jarvis').from('project_topics').select('*').eq('project_id', project.id);
    if (p.parent_id !== undefined) query = p.parent_id === null ? query.is('parent_id', null) : query.eq('parent_id', p.parent_id);

    const { data, error } = await query.order('order_index', { ascending: true });
    if (error) throw error;
    return data?.map(t => `- ${t.name || t.tag} (ID: ${t.id})`).join('\n') || 'Sem tópicos.';
  } catch (err: any) { return `Erro: ${err.message}`; }
}

// ─── ENTRIES ──────────────────────────────────────────────────────────────────

export async function executeGerenciarEntry(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { acao, topic_id, entry_id, type, title, body, status, order_index, metadata } = p;

    if (acao === 'criar') {
      const { data, error } = await supabase.schema('jarvis').from('project_entries').insert({ topic_id, type: type || 'note', title, body, status: status || 'open', order_index: order_index || 0, created_by: Number(targetId), metadata: metadata || {} }).select('id').single();
      if (error) throw error; return `Entry registrada (ID: ${data.id}).`;
    }
    if (acao === 'atualizar') {
      const { error } = await supabase.schema('jarvis').from('project_entries').update({ type, title, body, status, order_index, metadata }).eq('id', entry_id);
      if (error) throw error; return 'Entry atualizada.';
    }
    if (acao === 'remover') {
      const { error } = await supabase.schema('jarvis').from('project_entries').delete().eq('id', entry_id);
      if (error) throw error; return 'Entry removida.';
    }
    return 'Ação inválida.';
  } catch (err: any) { return `Erro: ${err.message}`; }
}

export async function executeListarEntries(p: any, _authUserId: string, _numericUserId: string): Promise<string> {
  try {
    let query = supabase.schema('jarvis').from('project_entries').select('*').eq('topic_id', p.topic_id);
    if (p.type) query = query.eq('type', p.type);
    if (p.status) query = query.eq('status', p.status);
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    return data?.map(e => `[${e.type.toUpperCase()}] ${e.title || 'Sem título'} (ID: ${e.id})`).join('\n') || 'Nenhuma entry.';
  } catch (err: any) { return `Erro: ${err.message}`; }
}

// ─── MEMBROS (COMPARTILHAMENTO DELEGADO PARA SSOT) ───────────────────────────

export async function executeGerenciarMembrosProjeto(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { acao, project_id, user_identifier, role } = p;

    const project = await resolveProject(project_id, targetId);
    if (!project) return `Projeto "${project_id}" não encontrado.`;

    if (acao === 'listar') {
      const membros = await coreListarMembrosProjeto(project.id);
      if (!membros.length) return 'Nenhum membro encontrado.';
      
      return membros.map((m: any) => {
        const u = Array.isArray(m.users) ? m.users[0] : m.users;
        return `- ${formatDisplayName(u)} | Papel: ${m.role} | Status: ${m.status}`;
      }).join('\n');
    }

    const targetUser = await resolveUser(user_identifier);
    if (!targetUser) return `Não encontrei ninguém com o identificador "${user_identifier}".`;

    if (acao === 'adicionar' || acao === 'atualizar') {
      await coreAtualizarMembroProjeto(Number(targetId), project.id, targetUser.id, true, role || 'viewer');
      return `Acesso de ${formatDisplayName(targetUser)} configurado como ${role || 'viewer'}.`;
    }

    if (acao === 'remover') {
      await coreAtualizarMembroProjeto(Number(targetId), project.id, targetUser.id, false);
      return `Acesso de ${formatDisplayName(targetUser)} removido.`;
    }

    return 'Ação de membros inválida.';
  } catch (err: any) { 
    return `Erro no compartilhamento: ${err.message}`; 
  }
}
