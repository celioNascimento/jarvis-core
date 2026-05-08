// lib/tools/executors/projects.ts
// Domínio: Projetos, Tópicos e Entries
// Tools: gerenciar_projeto, listar_projetos, gerenciar_topico, gerenciar_entry, listar_topicos, listar_entries

import { supabase } from '@/lib/jarvis';

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(s: string) { return Number(s); }

// Verifica se o usuário tem acesso ao projeto (owner, editor ou viewer ativo)
async function assertProjectAccess(
  projectId: string,
  numericUserId: string,
  requireEditor = false
): Promise<string | null> {
  const { data, error } = await supabase
    .schema('jarvis')
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', uid(numericUserId))
    .eq('status', 'active')
    .single();

  if (error || !data) return 'Projeto não encontrado ou acesso negado.';
  if (requireEditor && data.role === 'viewer') return 'Você tem apenas acesso de leitura neste projeto.';
  return null; // ok
}

// ── gerenciar_projeto ─────────────────────────────────────────────────────────

type GerenciarProjetoParams = {
  acao: 'criar' | 'atualizar' | 'arquivar';
  project_id?: string;
  tag?: string;
  name?: string;
  description?: string;
  status?: string;
  url?: string;
  repo_url?: string;
  cover_url?: string;
};

export async function executeGerenciarProjeto(
  p: GerenciarProjetoParams,
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    if (p.acao === 'criar') {
      if (!p.tag) return 'Erro: tag é obrigatória para criar um projeto.';

      const { data, error } = await supabase
        .schema('jarvis')
        .from('projects')
        .insert({
          user_id:     uid(numericUserId),
          tag:         p.tag,
          name:        p.name        ?? null,
          description: p.description ?? null,
          url:         p.url         ?? null,
          repo_url:    p.repo_url    ?? null,
          cover_url:   p.cover_url   ?? null,
        })
        .select('id, tag, name')
        .single();

      if (error) {
        if (error.code === '23505') return `Você já tem um projeto com a tag "${p.tag}".`;
        throw error;
      }
      return `Projeto "${data.name ?? data.tag}" criado com sucesso (id: ${data.id}).`;
    }

    if (p.acao === 'atualizar') {
      if (!p.project_id) return 'Erro: project_id é obrigatório para atualizar.';
      const denied = await assertProjectAccess(p.project_id, numericUserId, true);
      if (denied) return denied;

      const patch: Record<string, any> = {};
      if (p.name        !== undefined) patch.name        = p.name;
      if (p.description !== undefined) patch.description = p.description;
      if (p.status      !== undefined) patch.status      = p.status;
      if (p.url         !== undefined) patch.url         = p.url;
      if (p.repo_url    !== undefined) patch.repo_url    = p.repo_url;
      if (p.cover_url   !== undefined) patch.cover_url   = p.cover_url;

      if (!Object.keys(patch).length) return 'Nenhum campo para atualizar foi informado.';

      const { error } = await supabase
        .schema('jarvis')
        .from('projects')
        .update(patch)
        .eq('id', p.project_id);

      if (error) throw error;
      return `Projeto atualizado com sucesso.`;
    }

    if (p.acao === 'arquivar') {
      if (!p.project_id) return 'Erro: project_id é obrigatório para arquivar.';
      const denied = await assertProjectAccess(p.project_id, numericUserId, true);
      if (denied) return denied;

      const { error } = await supabase
        .schema('jarvis')
        .from('projects')
        .update({ status: 'cancelado' })
        .eq('id', p.project_id);

      if (error) throw error;
      return 'Projeto arquivado.';
    }

    return `Ação "${(p as any).acao}" não reconhecida.`;
  } catch (err: any) {
    return `Erro técnico em gerenciar_projeto: ${err.message}`;
  }
}

// ── listar_projetos ───────────────────────────────────────────────────────────

type ListarProjetosParams = {
  status?: string;
};

export async function executeListarProjetos(
  p: ListarProjetosParams,
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    // Busca todos os projetos onde o usuário é membro ativo
    const { data: memberships, error: mErr } = await supabase
      .schema('jarvis')
      .from('project_members')
      .select('project_id, role')
      .eq('user_id', uid(numericUserId))
      .eq('status', 'active');

    if (mErr) throw mErr;
    if (!memberships?.length) return 'Nenhum projeto encontrado.';

    const ids = memberships.map(m => m.project_id);

    let query = supabase
      .schema('jarvis')
      .from('projects')
      .select('id, tag, name, description, status, updated_at')
      .in('id', ids)
      .order('updated_at', { ascending: false });

    if (p.status) query = query.eq('status', p.status);

    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) return 'Nenhum projeto encontrado com esse filtro.';

    const roleMap = Object.fromEntries(memberships.map(m => [m.project_id, m.role]));

    return data.map(proj => {
      const role = roleMap[proj.id];
      const label = role === 'owner' ? '' : ` [${role}]`;
      return `• [${proj.status}]${label} ${proj.name ?? proj.tag} (${proj.tag}) — id: ${proj.id}${proj.description ? `\n  ${proj.description}` : ''}`;
    }).join('\n');
  } catch (err: any) {
    return `Erro técnico em listar_projetos: ${err.message}`;
  }
}

// ── gerenciar_topico ──────────────────────────────────────────────────────────

type GerenciarTopicoParams = {
  acao: 'criar' | 'atualizar' | 'remover';
  project_id: string;
  topic_id?: string;
  parent_id?: string;
  tag?: string;
  name?: string;
  description?: string;
  order_index?: number;
};

export async function executeGerenciarTopico(
  p: GerenciarTopicoParams,
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const denied = await assertProjectAccess(p.project_id, numericUserId, true);
    if (denied) return denied;

    if (p.acao === 'criar') {
      if (!p.tag) return 'Erro: tag é obrigatória para criar um tópico.';

      const { data, error } = await supabase
        .schema('jarvis')
        .from('project_topics')
        .insert({
          project_id:  p.project_id,
          parent_id:   p.parent_id   ?? null,
          tag:         p.tag,
          name:        p.name        ?? null,
          description: p.description ?? null,
          order_index: p.order_index ?? 0,
        })
        .select('id, tag, name')
        .single();

      if (error) {
        if (error.code === '23505') return `Já existe um tópico com a tag "${p.tag}" neste nível.`;
        throw error;
      }
      return `Tópico "${data.name ?? data.tag}" criado (id: ${data.id}).`;
    }

    if (p.acao === 'atualizar') {
      if (!p.topic_id) return 'Erro: topic_id é obrigatório para atualizar.';

      const patch: Record<string, any> = {};
      if (p.name        !== undefined) patch.name        = p.name;
      if (p.description !== undefined) patch.description = p.description;
      if (p.order_index !== undefined) patch.order_index = p.order_index;

      if (!Object.keys(patch).length) return 'Nenhum campo para atualizar foi informado.';

      const { error } = await supabase
        .schema('jarvis')
        .from('project_topics')
        .update(patch)
        .eq('id', p.topic_id)
        .eq('project_id', p.project_id);

      if (error) throw error;
      return 'Tópico atualizado.';
    }

    if (p.acao === 'remover') {
      if (!p.topic_id) return 'Erro: topic_id é obrigatório para remover.';

      const { error } = await supabase
        .schema('jarvis')
        .from('project_topics')
        .delete()
        .eq('id', p.topic_id)
        .eq('project_id', p.project_id);

      if (error) throw error;
      return 'Tópico e seus subtópicos removidos (cascade).';
    }

    return `Ação "${(p as any).acao}" não reconhecida.`;
  } catch (err: any) {
    return `Erro técnico em gerenciar_topico: ${err.message}`;
  }
}

// ── listar_topicos ────────────────────────────────────────────────────────────

type ListarTopicosParams = {
  project_id: string;
  parent_id?: string | null; // null = raiz; undefined = todos
};

export async function executeListarTopicos(
  p: ListarTopicosParams,
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const denied = await assertProjectAccess(p.project_id, numericUserId);
    if (denied) return denied;

    let query = supabase
      .schema('jarvis')
      .from('project_topics')
      .select('id, tag, name, description, parent_id, order_index')
      .eq('project_id', p.project_id)
      .order('order_index', { ascending: true });

    // Se parent_id foi passado explicitamente (mesmo que null), filtra por ele
    if ('parent_id' in p) {
      query = p.parent_id
        ? query.eq('parent_id', p.parent_id)
        : query.is('parent_id', null);
    }

    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) return 'Nenhum tópico encontrado.';

    return data.map(t =>
      `• ${t.name ?? t.tag} (${t.tag}) — id: ${t.id}${t.description ? `\n  ${t.description}` : ''}`
    ).join('\n');
  } catch (err: any) {
    return `Erro técnico em listar_topicos: ${err.message}`;
  }
}

// ── gerenciar_entry ───────────────────────────────────────────────────────────

type GerenciarEntryParams = {
  acao: 'criar' | 'atualizar' | 'remover';
  topic_id: string;
  project_id: string;
  entry_id?: string;
  type?: string;
  title?: string;
  body?: string;
  status?: string;
  order_index?: number;
  metadata?: Record<string, any>;
};

export async function executeGerenciarEntry(
  p: GerenciarEntryParams,
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const denied = await assertProjectAccess(p.project_id, numericUserId, true);
    if (denied) return denied;

    if (p.acao === 'criar') {
      const { data, error } = await supabase
        .schema('jarvis')
        .from('project_entries')
        .insert({
          topic_id:    p.topic_id,
          type:        p.type        ?? 'note',
          title:       p.title       ?? null,
          body:        p.body        ?? null,
          status:      p.status      ?? 'open',
          order_index: p.order_index ?? 0,
          created_by:  uid(numericUserId),
          metadata:    p.metadata    ?? {},
        })
        .select('id, type, title')
        .single();

      if (error) throw error;
      return `Entry "${data.title ?? data.type}" registrada (id: ${data.id}).`;
    }

    if (p.acao === 'atualizar') {
      if (!p.entry_id) return 'Erro: entry_id é obrigatório para atualizar.';

      const patch: Record<string, any> = {};
      if (p.title       !== undefined) patch.title       = p.title;
      if (p.body        !== undefined) patch.body        = p.body;
      if (p.status      !== undefined) patch.status      = p.status;
      if (p.type        !== undefined) patch.type        = p.type;
      if (p.order_index !== undefined) patch.order_index = p.order_index;
      if (p.metadata    !== undefined) patch.metadata    = p.metadata;

      if (!Object.keys(patch).length) return 'Nenhum campo para atualizar foi informado.';

      const { error } = await supabase
        .schema('jarvis')
        .from('project_entries')
        .update(patch)
        .eq('id', p.entry_id)
        .eq('topic_id', p.topic_id);

      if (error) throw error;
      return 'Entry atualizada.';
    }

    if (p.acao === 'remover') {
      if (!p.entry_id) return 'Erro: entry_id é obrigatório para remover.';

      const { error } = await supabase
        .schema('jarvis')
        .from('project_entries')
        .delete()
        .eq('id', p.entry_id)
        .eq('topic_id', p.topic_id);

      if (error) throw error;
      return 'Entry removida.';
    }

    return `Ação "${(p as any).acao}" não reconhecida.`;
  } catch (err: any) {
    return `Erro técnico em gerenciar_entry: ${err.message}`;
  }
}

// ── listar_entries ────────────────────────────────────────────────────────────

type ListarEntriesParams = {
  project_id: string;
  topic_id: string;
  type?: string;
  status?: string;
};

export async function executeListarEntries(
  p: ListarEntriesParams,
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const denied = await assertProjectAccess(p.project_id, numericUserId);
    if (denied) return denied;

    let query = supabase
      .schema('jarvis')
      .from('project_entries')
      .select('id, type, title, body, status, created_at')
      .eq('topic_id', p.topic_id)
      .order('order_index', { ascending: true })
      .order('created_at', { ascending: true });

    if (p.type)   query = query.eq('type', p.type);
    if (p.status) query = query.eq('status', p.status);

    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) return 'Nenhuma entry encontrada.';

    return data.map(e => {
      const header = `• [${e.status}] ${e.type.toUpperCase()}: ${e.title ?? '(sem título)'} — id: ${e.id}`;
      return e.body ? `${header}\n  ${e.body.substring(0, 120)}${e.body.length > 120 ? '…' : ''}` : header;
    }).join('\n');
  } catch (err: any) {
    return `Erro técnico em listar_entries: ${err.message}`;
  }
}