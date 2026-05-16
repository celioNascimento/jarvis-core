// lib/services/projects.service.ts
// V1.0.0 — Fonte Única da Verdade (SSOT) para Projetos — Schema Jarvis

import { supabase } from '@/lib/jarvis';

// ─── 1. LISTAR PROJETOS DO USUÁRIO ───────────────────────────────────────────
export async function coreListarProjetos(userId: number, status?: string) {
  // Busca os IDs dos projetos onde o usuário é membro
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

  // Anexa o papel do usuário no payload de resposta para o frontend
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
  // 1. Cria o projeto
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

  // 2. Insere o dono automaticamente como membro Owner ativo
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

// ─── HELPER DE PERMISSÃO (DRY) ────────────────────────────────────────────────
async function validarPermissaoProjeto(userId: number, projectId: string, requiresEditor: boolean = false) {
  const { data: member, error } = await supabase
    .schema('jarvis')
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .single();

  if (error || !member) throw new Error('Projeto não encontrado ou acesso negado.');
  
  if (requiresEditor && !['owner', 'editor'].includes(member.role)) {
    throw new Error('FORBIDDEN: Sem permissão de edição neste projeto.');
  }
  
  return member.role;
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

// Lista todos os membros atuais de um projeto
export async function coreListarMembrosProjeto(projectId: string) {
  const { data, error } = await supabase
    .schema('jarvis')
    .from('project_members')
    .select('user_id, role, status, users ( name, preferred_name, nickname, email )')
    .eq('project_id', projectId);
  
  if (error) throw new Error(`Erro ao listar membros: ${error.message}`);
  return data;
}

// Altera o status/papel de um membro no projeto
export async function coreAtualizarMembroProjeto(
  ownerId: number, 
  projectId: string, 
  targetUserId: number, 
  active: boolean, 
  role: string = 'editor'
) {
  // 1. Valida se quem está pedindo a ação é dono ou editor do projeto
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

