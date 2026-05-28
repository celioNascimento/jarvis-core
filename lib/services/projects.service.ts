// lib/services/projects.service.ts
// V1.1.0 — Fonte Única da Verdade (SSOT) para Projetos & Membros — Schema Jarvis

import { supabase } from '@/lib/jarvis';
import { invalidateContextField } from '@/lib/services/context-cache';

// ─── HELPER DE PERMISSÃO (DRY) ────────────────────────────────────────────────
async function validarPermissaoProjeto(userId: number, projectId: string, requiresEditor: boolean = false) {
  const { data: member, error } = await supabase
    .schema('jarvis')
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !member) throw new Error('Projeto não encontrado ou acesso negado.');
  
  if (requiresEditor && !['owner', 'editor'].includes(member.role)) {
    throw new Error('FORBIDDEN: Sem permissão de edição neste projeto.');
  }
  
  return member.role;
}

// ─── 1. LISTAR PROJETOS DO USUÁRIO ───────────────────────────────────────────
export async function coreListarProjetos(userId: number, status?: string) {
  const { data: memberships, error: memErr } = await supabase
    .schema('jarvis')
    .from('project_members')
    .select('project_id, role, status')
    .eq('user_id', userId);

  if (memErr) throw new Error(`Erro ao buscar permissões: ${memErr.message}`);
  if (!memberships || memberships.length === 0) return [];

  const projectIds = memberships.map(m => m.project_id);

  let query = supabase
    .schema('jarvis')
    .from('projects')
    .select('*')
    .in('id', projectIds)
    .order('updated_at', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data: projects, error: projErr } = await query;
  if (projErr) throw new Error(`Erro ao listar projetos: ${projErr.message}`);

  return projects.map(p => {
    const mem = memberships.find(m => m.project_id === p.id);
    return {
      ...p,
      my_role: mem?.role || 'viewer',
      member_status: mem?.status || 'active'
    };
  });
}

// ─── 2. CRIAR PROJETO ────────────────────────────────────────────────────────
export async function coreCriarProjeto(userId: number, payload: any) {
  const { data: project, error: projErr } = await supabase
    .schema('jarvis')
    .from('projects')
    .insert({
      user_id: userId,
      tag: payload.tag,
      name: payload.name,
      description: payload.description,
      status: payload.status || 'em_desenvolvimento',
      url: payload.url,
      repo_url: payload.repo_url,
      cover_url: payload.cover_url,
    })
    .select()
    .single();

  if (projErr) throw new Error(`Falha ao criar projeto: ${projErr.message}`);

  await supabase
    .schema('jarvis')
    .from('project_members')
    .insert({
      project_id: project.id,
      user_id: userId,
      invited_by: userId,
      role: 'owner',
      status: 'active'
    });

  return project;
}

// ─── 3. ATUALIZAR PROJETO ────────────────────────────────────────────────────
export async function coreAtualizarProjeto(userId: number, projectId: string, updates: any) {
  await validarPermissaoProjeto(userId, projectId, true);

  const { error } = await supabase
    .schema('jarvis')
    .from('projects')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', projectId);

  if (error) throw new Error(`Falha ao atualizar projeto: ${error.message}`);
  return true;
}

// ─── 4. DELETAR (OU ARQUIVAR) PROJETO ────────────────────────────────────────
export async function coreDeletarProjeto(userId: number, projectId: string) {
  const role = await validarPermissaoProjeto(userId, projectId, false);
  
  if (role !== 'owner') {
    throw new Error('FORBIDDEN: Apenas o dono pode excluir o projeto.');
  }

  const { error } = await supabase
    .schema('jarvis')
    .from('projects')
    .delete()
    .eq('id', projectId);

  if (error) throw new Error(`Falha ao deletar projeto: ${error.message}`);
  return true;
}

// ─── 5. COMPARTILHAMENTO E MEMBROS (SSOT) ────────────────────────────────────
export async function coreListarMembrosProjeto(projectId: string) {
  const { data, error } = await supabase
    .schema('jarvis')
    .from('project_members')
    .select('user_id, role, status, users ( name, preferred_name, nickname, email )')
    .eq('project_id', projectId);
  
  if (error) throw new Error(`Erro ao listar membros: ${error.message}`);
  return data || [];
}

export async function coreAtualizarMembroProjeto(
  ownerId: number, 
  projectId: string, 
  targetUserId: number, 
  active: boolean, 
  role: string = 'editor'
) {
  await validarPermissaoProjeto(ownerId, projectId, true);

  if (active) {
    const { error } = await supabase
      .schema('jarvis')
      .from('project_members')
      .upsert(
        { 
          project_id: projectId, 
          user_id: targetUserId, 
          invited_by: ownerId,
          role: role, 
          status: 'active' 
        },
        { onConflict: 'project_id,user_id' }
      );
    if (error) throw new Error(`Falha ao adicionar membro: ${error.message}`);
  } else {
    const { error } = await supabase
      .schema('jarvis')
      .from('project_members')
      .delete()
      .eq('project_id', projectId)
      .eq('user_id', targetUserId);
    if (error) throw new Error(`Falha ao remover membro: ${error.message}`);
  }
  return true;
}

// ─── 6. ENTRIES (TAREFAS / CARDS DO KANBAN) ──────────────────────────────────

export async function coreListarEntriesDoProjeto(projectId: string) {
  // Como as entries pertencem aos tópicos, fazemos um inner join para pegar 
  // todas as tarefas vinculadas aos tópicos deste projeto específico.
  const { data, error } = await supabase
    .schema('jarvis')
    .from('project_entries')
    .select('*, project_topics!inner(project_id)')
    .eq('project_topics.project_id', projectId)
    .order('order_index', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Erro ao listar tarefas do projeto: ${error.message}`);
  return data || [];
}

export async function coreAtualizarStatusEntry(userId: number, entryId: string, novoStatus: string) {
  // Atualiza a coluna (status) da tarefa
  const { error } = await supabase
    .schema('jarvis')
    .from('project_entries')
    .update({ 
      status: novoStatus, 
      updated_at: new Date().toISOString() 
    })
    .eq('id', entryId);

  if (error) throw new Error(`Falha ao mover a tarefa: ${error.message}`);
  return true;
}

// ─── 7. ADAPTER PARA O EXTRATOR DE IA ─────────────────────────────────────────

export const projectService = {
  async upsertProject(userId: number, proj: any) {
    const payload: any = { 
      user_id: userId, 
      tag: proj.tag, 
      name: proj.nome, 
      status: proj.status || 'ideia', 
      updated_at: new Date().toISOString() 
    };
    if (proj.descricao) payload.description = proj.descricao;
    if (proj.contexto_tecnico) payload.context_technical = proj.contexto_tecnico;

    // Mantemos o upsert direto aqui pela agilidade do onConflict
    await supabase.schema('jarvis').from('projects').upsert(payload, { onConflict: 'user_id,tag' });
    await invalidateContextField(userId, 'projects').catch(() => {});
  }
};