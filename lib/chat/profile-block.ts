// lib/chat/profile-block.ts
// Camada de perfil unificada — injeta no system prompt tudo que é estático ou semi-estático.
// Lê em paralelo de todas as tabelas relevantes do schema jarvis.
// Não depende de RAG ou embedding — sempre presente, nunca esquece.

import { supabase } from '@/lib/jarvis';

export interface ProfileBlockOptions {
  userId: number;       // jarvis.users.id (bigint)
  authUserId: string;   // auth.users.id (uuid) — para user_accounts / transactions / budgets
  authorName: string;
  contexts?: string[];  // detectedContexts — habilita seções condicionais
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcAge(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 3.15576e10);
}

function fmtDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('pt-BR');
}

function daysFromNow(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

// ─── Seções fixas (sempre no prompt) ─────────────────────────────────────────

async function sectionPerfil(userId: number, authorName: string): Promise<string> {
  const { data: p } = await supabase
    .schema('jarvis')
    .from('user_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (!p) return '';

  const lines: string[] = [];

  if (p.full_name || p.preferred_name)
    lines.push(`Nome: ${p.full_name || ''}${p.preferred_name ? ` (prefere: ${p.preferred_name})` : ''}`);
  if (p.nickname) lines.push(`Apelido: ${p.nickname}`);
  if (p.birth_date) lines.push(`Nascimento: ${fmtDate(p.birth_date)} (${calcAge(p.birth_date)} anos)`);
  if (p.birth_city || p.birth_state)
    lines.push(`Natural de: ${[p.birth_city, p.birth_state].filter(Boolean).join(', ')}`);
  if (p.gender) lines.push(`Gênero: ${p.gender}`);
  if (p.city || p.state)
    lines.push(`Mora em: ${[p.city, p.state].filter(Boolean).join(', ')}`);
  if (p.profession || p.current_job)
    lines.push(`Profissão: ${p.profession || ''}${p.current_job ? ` — ${p.current_job}` : ''}`);
  if (p.company) lines.push(`Empresa: ${p.company}`);
  if (p.job_start_date) lines.push(`Na empresa desde: ${fmtDate(p.job_start_date)}`);
  if (p.career_notes) lines.push(`Carreira: ${p.career_notes}`);
  if (p.education_level) lines.push(`Escolaridade: ${p.education_level.replace(/_/g, ' ')}`);
  if (p.schools?.length) lines.push(`Escolas/Faculdades: ${p.schools.join(', ')}`);
  if (p.faith_profile && p.faith_profile !== 'unknown')
    lines.push(`Fé: ${p.faith_profile}${p.faith_notes ? ` — ${p.faith_notes}` : ''}`);
  if (p.father_name) lines.push(`Pai: ${p.father_name}`);
  if (p.mother_name) lines.push(`Mãe: ${p.mother_name}`);
  if (p.siblings_count != null) lines.push(`Irmãos: ${p.siblings_count}`);
  if (p.personality_notes) lines.push(`Personalidade: ${p.personality_notes}`);
  if (p.phone || p.whatsapp) lines.push(`Contato: ${p.phone || p.whatsapp}`);

  if (p.spouse_name) {
    const sp: string[] = [`Cônjuge: ${p.spouse_name}`];
    if (p.spouse_birthday) {
      const daysLeft = daysFromNow(p.spouse_birthday);
      const flag = daysLeft >= 0 && daysLeft <= 7 ? ' 🎂 ESTA SEMANA!' : daysLeft >= 0 && daysLeft <= 30 ? ` (em ${daysLeft} dias)` : '';
      sp.push(`aniversário: ${fmtDate(p.spouse_birthday)}${flag}`);
    }
    if (p.spouse_phone) sp.push(`tel: ${p.spouse_phone}`);
    lines.push(sp.join(' · '));
  }

  return lines.length ? `[PERFIL DE ${authorName.toUpperCase()}]\n${lines.join('\n')}` : '';
}

async function sectionFilhos(userId: number, authorName: string): Promise<string> {
  const { data } = await supabase
    .schema('jarvis')
    .from('children')
    .select('name, nickname, birth_date, gender, life_phase, school_name, school_grade, school_shift, special_needs, lev_notes, other_parent_name')
    .eq('parent_id', String(userId));

  const children = data || [];

  if (!children.length)
    return `[FILHOS DE ${authorName.toUpperCase()}]\nNenhum filho cadastrado.`;

  const lines = children.map((c: any) => {
    const parts: string[] = [];
    parts.push(c.nickname ? `${c.name} (${c.nickname})` : c.name);
    if (c.birth_date) parts.push(`${calcAge(c.birth_date)} anos`);
    if (c.life_phase) parts.push(c.life_phase);
    if (c.school_name)
      parts.push(`escola: ${c.school_name}${c.school_grade ? ` ${c.school_grade}` : ''}${c.school_shift ? ` (${c.school_shift})` : ''}`);
    if (c.special_needs?.length) parts.push(`necessidades: ${c.special_needs.join(', ')}`);
    if (c.other_parent_name) parts.push(`outro pai/mãe: ${c.other_parent_name}`);
    if (c.lev_notes) parts.push(c.lev_notes);
    return `- ${parts.join(' · ')}`;
  });

  return `[FILHOS DE ${authorName.toUpperCase()}]\n${lines.join('\n')}`;
}

async function sectionRelacionamentos(userId: number): Promise<string> {
  const userIdStr = String(userId);

  // Busca relacionamentos ativos + seus eventos e memórias em paralelo
  const { data: rels } = await supabase
    .schema('jarvis')
    .from('relationships')
    .select('id, contact_name, relationship_type, contact_phone, contact_birthday, is_external, status')
    .eq('user_id_a', userIdStr)
    .eq('status', 'active')
    .limit(20);

  if (!rels?.length) return '';

  const today = new Date();
  const in30 = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);

  // Busca eventos e memórias de todos os relacionamentos em paralelo
  const relIds = rels.map((r: any) => r.id);

  const [relEventsRes, relMemoriesRes] = await Promise.allSettled([
    supabase
      .schema('jarvis')
      .from('relationship_events')
      .select('relationship_id, title, event_date, category, is_recurring, notes, emotional_weight')
      .in('relationship_id', relIds)
      .gte('event_date', todayStr)
      .lte('event_date', in30)
      .order('event_date', { ascending: true }),

    supabase
      .schema('jarvis')
      .from('relationship_memories')
      .select('relationship_id, summary, period_start, period_end')
      .in('relationship_id', relIds)
      .order('frozen_at', { ascending: false }),
  ]);

  // Indexa eventos e memórias por relationship_id
  const eventsByRel: Record<string, any[]> = {};
  if (relEventsRes.status === 'fulfilled') {
    for (const ev of relEventsRes.value.data || []) {
      if (!eventsByRel[ev.relationship_id]) eventsByRel[ev.relationship_id] = [];
      eventsByRel[ev.relationship_id].push(ev);
    }
  }

  const memoriesByRel: Record<string, any[]> = {};
  if (relMemoriesRes.status === 'fulfilled') {
    for (const mem of relMemoriesRes.value.data || []) {
      if (!memoriesByRel[mem.relationship_id]) memoriesByRel[mem.relationship_id] = [];
      memoriesByRel[mem.relationship_id].push(mem);
    }
  }

  const sections: string[] = [];

  // Externos (contatos manuais)
  const externos = rels.filter((r: any) => r.is_external);
  if (externos.length) {
    const lines = externos.flatMap((r: any) => {
      const header: string[] = [`${r.contact_name} (${r.relationship_type})`];
      if (r.contact_birthday) {
        const days = daysFromNow(r.contact_birthday);
        const flag = days >= 0 && days <= 7 ? ' 🎂 ESTA SEMANA!' : days >= 0 && days <= 30 ? ` (em ${days} dias)` : '';
        header.push(`aniv: ${fmtDate(r.contact_birthday)}${flag}`);
      }
      if (r.contact_phone) header.push(`tel: ${r.contact_phone}`);

      const result = [`- ${header.join(' · ')}`];

      // Eventos próximos deste relacionamento
      const evs = eventsByRel[r.id] || [];
      for (const ev of evs) {
        const days = daysFromNow(ev.event_date);
        result.push(`  ↳ ${ev.title}: ${fmtDate(ev.event_date)}${days <= 7 ? ' ⚠️ PRÓXIMO' : ''}`);
      }

      // Memórias congeladas (máx 2 por pessoa)
      const mems = (memoriesByRel[r.id] || []).slice(0, 2);
      for (const mem of mems) {
        result.push(`  ↳ [mem] ${mem.summary}`);
      }

      return result;
    });
    sections.push(`[PESSOAS PRÓXIMAS]\n${lines.join('\n')}`);
  }

  // Internos (usuários do app conectados) — só nome e tipo, sem dados sensíveis
  const internos = rels.filter((r: any) => !r.is_external);
  if (internos.length) {
    const lines = internos.map((r: any) => `- ${r.contact_name || r.user_id_b} (${r.relationship_type})`);
    sections.push(`[FAMÍLIA NO APP]\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}

async function sectionLembretes(userId: number): Promise<string> {
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString();
  const { data } = await supabase
    .schema('jarvis')
    .from('reminders')
    .select('title, type, scheduled_time, frequency, location_trigger, metadata')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .or(`scheduled_time.lte.${in7},type.eq.location,type.eq.recurring`)
    .order('scheduled_time', { ascending: true })
    .limit(15);

  if (!data?.length) return '';

  const lines = data.map((r: any) => {
    const parts: string[] = [r.title];
    if (r.scheduled_time) {
      const days = daysFromNow(r.scheduled_time);
      parts.push(days === 0 ? 'HOJE' : days === 1 ? 'AMANHÃ' : fmtDate(r.scheduled_time));
    }
    if (r.frequency) parts.push(`recorrente: ${r.frequency}`);
    if (r.location_trigger) parts.push(`local: ${r.location_trigger}`);
    return `- ${parts.join(' · ')}`;
  });

  return `[LEMBRETES PENDENTES]\n${lines.join('\n')}`;
}

async function sectionAgenda(userId: number): Promise<string> {
  const todayStr = new Date().toISOString().slice(0, 10);
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString();

  const { data } = await supabase
    .schema('jarvis')
    .from('agenda')
    .select('description, event_at, category')
    .eq('user_id', userId)
    .gte('event_at', todayStr)
    .lte('event_at', in7)
    .order('event_at', { ascending: true })
    .limit(10);

  if (!data?.length) return '';

  const lines = data.map((a: any) => {
    const dt = new Date(a.event_at);
    const days = daysFromNow(a.event_at);
    const when = days === 0 ? 'HOJE' : days === 1 ? 'AMANHÃ' : fmtDate(a.event_at);
    const time = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `- ${a.description} · ${when} às ${time}${a.category ? ` [${a.category}]` : ''}`;
  });

  return `[AGENDA INTERNA — PRÓXIMOS 7 DIAS]\n${lines.join('\n')}`;
}

async function sectionDocumentos(userId: number): Promise<string> {
  const { data } = await supabase
    .schema('jarvis')
    .from('documents')
    .select('label, icon, expires_at')
    .eq('user_id', userId);

  if (!data?.length) return '';

  const lines = data.map((d: any) => {
    const parts = [`${d.icon || '📄'} ${d.label}`];
    if (d.expires_at) {
      const days = daysFromNow(d.expires_at);
      if (days < 0) parts.push('⚠️ VENCIDO');
      else if (days <= 30) parts.push(`⚠️ vence em ${days} dias (${fmtDate(d.expires_at)})`);
      else parts.push(`validade: ${fmtDate(d.expires_at)}`);
    }
    return `- ${parts.join(' · ')}`;
  });

  return `[DOCUMENTOS]\n${lines.join('\n')}`;
}

async function sectionCompras(userId: number): Promise<string> {
  const { data } = await supabase
    .schema('jarvis')
    .from('shopping_items')
    .select('item')
    .eq('user_id', String(userId))
    .eq('done', false)
    .limit(30);

  if (!data?.length) return '';

  return `[LISTA DE COMPRAS]\n${data.map((i: any) => `- ${i.item}`).join('\n')}`;
}

// ─── Seções condicionais (só entram quando contexto relevante) ────────────────

async function sectionProjetos(userId: number): Promise<string> {
  const { data } = await supabase
    .schema('jarvis')
    .from('projects')
    .select('name, tag, description, status, url')
    .eq('user_id', userId)
    .in('status', ['em_desenvolvimento', 'em_pausa'])
    .order('updated_at', { ascending: false })
    .limit(10);

  if (!data?.length) return '';

  const lines = data.map((p: any) => {
    const parts = [`${p.name || p.tag} [${p.status}]`];
    if (p.description) parts.push(p.description);
    if (p.url) parts.push(p.url);
    return `- ${parts.join(' · ')}`;
  });

  return `[PROJETOS ATIVOS]\n${lines.join('\n')}`;
}

async function sectionFinancas(authUserId: string): Promise<string> {
  const sections: string[] = [];

  const [accountsRes, budgetsRes, recentTxRes] = await Promise.allSettled([
    supabase
      .schema('jarvis')
      .from('user_accounts')
      .select('bank_name, account_label, account_type')
      .eq('user_id', authUserId)
      .eq('is_active', true),

    supabase
      .schema('jarvis')
      .from('budgets')
      .select('amount, period_start, period_end, categories(name, slug)')
      .eq('user_id', authUserId)
      .lte('period_start', new Date().toISOString().slice(0, 10))
      .gte('period_end', new Date().toISOString().slice(0, 10))
      .limit(10),

    supabase
      .schema('jarvis')
      .from('transactions')
      .select('amount, type, description, merchant, transaction_date, categories(name)')
      .eq('user_id', authUserId)
      .eq('status', 'confirmed')
      .order('transaction_date', { ascending: false })
      .limit(10),
  ]);

  if (accountsRes.status === 'fulfilled' && accountsRes.value.data?.length) {
    const lines = accountsRes.value.data.map((a: any) =>
      `- ${a.bank_name}${a.account_label ? ` (${a.account_label})` : ''} [${a.account_type}]`
    );
    sections.push(`Contas:\n${lines.join('\n')}`);
  }

  if (budgetsRes.status === 'fulfilled' && budgetsRes.value.data?.length) {
    const lines = budgetsRes.value.data.map((b: any) => {
      const cat = (b as any).categories?.name || 'Geral';
      return `- ${cat}: R$ ${Number(b.amount).toFixed(2)} (${fmtDate(b.period_start)} – ${fmtDate(b.period_end)})`;
    });
    sections.push(`Orçamentos ativos:\n${lines.join('\n')}`);
  }

  if (recentTxRes.status === 'fulfilled' && recentTxRes.value.data?.length) {
    const lines = recentTxRes.value.data.map((t: any) => {
      const sign = t.type === 'income' || t.type === 'transfer_in' ? '+' : '-';
      const label = t.merchant || t.description || 'sem descrição';
      const cat = (t as any).categories?.name ? ` [${(t as any).categories.name}]` : '';
      return `- ${sign}R$ ${Number(t.amount).toFixed(2)} · ${label}${cat} · ${fmtDate(t.transaction_date)}`;
    });
    sections.push(`Últimas transações:\n${lines.join('\n')}`);
  }

  return sections.length ? `[FINANÇAS]\n${sections.join('\n\n')}` : '';
}

async function sectionLugaresPreferidos(userId: number): Promise<string> {
  const { data } = await supabase
    .schema('jarvis')
    .from('favorite_places')
    .select('name, category')
    .eq('user_id', String(userId))
    .limit(15);

  if (!data?.length) return '';

  const lines = data.map((p: any) => `- ${p.name}${p.category ? ` [${p.category}]` : ''}`);
  return `[LUGARES FAVORITOS]\n${lines.join('\n')}`;
}

// ─── Entrypoint público ───────────────────────────────────────────────────────

export async function buildProfileBlock({
  userId,
  authUserId,
  authorName,
  contexts = [],
}: ProfileBlockOptions): Promise<string> {
  const hasContext = (...ctxs: string[]) => ctxs.some(c => contexts.includes(c));
  const isTrivial = hasContext('math', 'trivial');

  if (isTrivial) return ''; // mensagens triviais não precisam de perfil

  // ── Seções fixas — sempre carregadas em paralelo ────────────────────────────
  const fixedTasks = await Promise.allSettled([
    sectionPerfil(userId, authorName),       // 0
    sectionFilhos(userId, authorName),       // 1
    sectionRelacionamentos(userId),          // 2
    sectionLembretes(userId),               // 3
    sectionAgenda(userId),                  // 4
    sectionDocumentos(userId),              // 5
    sectionCompras(userId),                 // 6
  ]);

  // ── Seções condicionais — só carregadas quando contexto relevante ────────────
  const conditionalTasks = await Promise.allSettled([
    hasContext('projeto') ? sectionProjetos(userId) : Promise.resolve(''),                         // 7
    hasContext('financas') ? sectionFinancas(authUserId) : Promise.resolve(''),                    // 8
    hasContext('compras', 'rotina') ? sectionLugaresPreferidos(userId) : Promise.resolve(''),      // 9
  ]);

  const all = [...fixedTasks, ...conditionalTasks];
  const sections = all
    .map(r => (r.status === 'fulfilled' ? r.value : ''))
    .filter(Boolean);

  return sections.join('\n\n');
}
