// lib/tools/executors/projects.ts
import { supabase } from '@/lib/jarvis';
import { getEffectiveUserId } from '@/lib/modules/relationships';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const isUUID = (str: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);

async function resolveProjectId(identifier: string, numericUserId: string): Promise<string | null> {
  if (!identifier) return null;
  if (isUUID(identifier)) return identifier;

  const { data } = await supabase
    .from('projects')
    .select('id')
    .eq('user_id', Number(numericUserId))
    .or(`tag.eq.${identifier},name.ilike.%${identifier}%`)
    .limit(1)
    .maybeSingle();

  return data?.id || null;
}

async function resolveUserId(identifier: string): Promise<number | null> {
  if (!identifier) return null;
  if (/^\d+$/.test(identifier)) return Number(identifier);

  const { data } = await supabase
    .from('users')
    .select('id')
    .or(`email.ilike.%${identifier}%,name.ilike.%${identifier}%`)
    .limit(1)
    .maybeSingle();

  return data?.id || null;
}

// ─── PROJETOS ─────────────────────────────────────────────────────────────────

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
      return `Projeto "${data.name || data.tag}" criado. ID: ${data.id}`;
    }

    const pid = await resolveProjectId(p.project_id, targetId);
    if (!pid) return `Projeto "${p.project_id}" não encontrado.`;

    const updates: any = { name, description, url, repo_url, cover_url };
    if (status) updates.status = status;
    if (acao === 'arquivar') updates.status = 'em_pausa';
    if (acao === 'reativar') updates.status = 'em_desenvolvimento';
    if (acao === 'concluir') updates.status = 'concluido';
    if (acao === 'cancelar') updates.status = 'cancelado';

    const { error } = await supabase.from('projects').update(updates).eq('id', pid);
    if (error) throw error;

    return `Projeto ${acao === 'atualizar' ? 'atualizado' : acao + 'do'} com sucesso.`;
  } catch (err: any) { return `Erro: ${err.message}`; }
}

export async function executeListarProjetos(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    let query = supabase.from('projects').select('*').eq('user_id', Number(targetId));
    if (p.status) query = query.eq('status', p.status);

    const { data, error } = await query.order('updated_at', { ascending: false });
    if (error) throw error;
    if (!data?.length) return 'Nenhum projeto encontrado.';

    return data.map(pj => `[${pj.status.toUpperCase()}] ${pj.name || pj.tag} (ID: ${pj.id})`).join('\n');
  } catch (err: any) { return `Erro: ${err.message}`; }
}

// ─── TÓPICOS ──────────────────────────────────────────────────────────────────

export async function executeGerenciarTopico(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { acao, topic_id, parent_id, tag, name, description, order_index } = p;

    const pid = await resolveProjectId(p.project_id, targetId);
    if (!pid) return `Projeto "${p.project_id}" não localizado.`;

    if (acao === 'criar') {
      const { data, error } = await supabase
        .from('project_topics')
        .insert({ project_id: pid, parent_id, tag, name, description, order_index: order_index || 0 })
        .select().single();
      if (error) throw error;
      return `Tópico "${data.tag}" criado. ID: ${data.id}`;
    }

    if (!topic_id) return 'ID do tópico é obrigatório para esta ação.';

    if (acao === 'atualizar') {
      const { error } = await supabase.from('project_topics').update({ parent_id, tag, name, description, order_index }).eq('id', topic_id);
      if (error) throw error;
      return 'Tópico atualizado.';
    }

    if (acao === 'remover') {
      const { error } = await supabase.from('project_topics').delete().eq('id', topic_id);
      if (error) throw error;
      return 'Tópico removido (cascata ativa).';
    }

    return 'Ação inválida.';
  } catch (err: any) { return `Erro: ${err.message}`; }
}

export async function executeListarTopicos(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const pid = await resolveProjectId(p.project_id, targetId);
    if (!pid) return 'Projeto não encontrado.';

    let query = supabase.from('project_topics').select('*').eq('project_id', pid);
    if (p.parent_id !== undefined) {
      query = p.parent_id === null ? query.is('parent_id', null) : query.eq('parent_id', p.parent_id);
    }

    const { data, error } = await query.order('order_index', { ascending: true });
    if (error) throw error;
    return data?.map(t => `- ${t.name || t.tag} (ID: ${t.id})`).join('\n') || 'Nenhum tópico.';
  } catch (err: any) { return `Erro: ${err.message}`; }
}

// ─── ENTRIES ──────────────────────────────────────────────────────────────────

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
      return `Entry criada. ID: ${data.id}`;
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
  } catch (err: any) { return `Erro: ${err.message}`; }
}

export async function executeListarEntries(p: any, _authUserId: string, _numericUserId: string): Promise<string> {
  try {
    let query = supabase.from('project_entries').select('*').eq('topic_id', p.topic_id);
    if (p.type) query = query.eq('type', p.type);
    if (p.status) query = query.eq('status', p.status);

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    return data?.map(e => `[${e.type.toUpperCase()}] ${e.title || 'Sem título'} (ID: ${e.id})`).join('\n') || 'Vazio.';
  } catch (err: any) { return `Erro: ${err.message}`; }
}

// ─── MEMBROS (COMPARTILHAMENTO) ───────────────────────────────────────────────

export async function executeGerenciarMembrosProjeto(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const { acao, project_id, user_identifier, role } = p;

    const pid = await resolveProjectId(project_id, targetId);
    if (!pid) return `Projeto "${project_id}" não encontrado.`;

    if (acao === 'listar') {
      const { data, error } = await supabase.from('project_members').select('role, status, users ( name, email )').eq('project_id', pid);
      if (error) throw error;
      return data.map(m => {
        const u: any = Array.isArray(m.users) ? m.users[0] : m.users;
        return `- ${u?.name || u?.email || 'Membro'} | Papel: ${m.role} | Status: ${m.status}`;
      }).join('\n');
    }

    const tUserId = await resolveUserId(user_identifier);
    if (!tUserId) return `Usuário "${user_identifier}" não encontrado.`;

    if (acao === 'adicionar') {
      const { error } = await supabase.from('project_members').insert({ project_id: pid, user_id: tUserId, invited_by: Number(targetId), role: role || 'viewer', status: 'pending' });
      if (error) return error.code === '23505' ? 'Já é membro.' : `Erro: ${error.message}`;
      return `Convite enviado para "${user_identifier}".`;
    }

    if (acao === 'atualizar') {
      const { error } = await supabase.from('project_members').update({ role }).eq('project_id', pid).eq('user_id', tUserId);
      if (error) throw error;
      return 'Papel atualizado.';
    }

    if (acao === 'remover') {
      const { error } = await supabase.from('project_members').delete().eq('project_id', pid).eq('user_id', tUserId);
      if (error) throw error;
      return 'Membro removido.';
    }
    return 'Ação inválida.';
  } catch (err: any) { return `Erro: ${err.message}`; }
}