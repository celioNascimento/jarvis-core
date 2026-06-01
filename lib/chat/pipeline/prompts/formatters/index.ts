// lib/chat/pipeline/formatters/index.ts
//
// Funções PURAS de formatação — recebem dados, devolvem string.
// Sem I/O, sem LLM, sem banco. Testáveis unitariamente.

// ── Família ───────────────────────────────────────────────────────────────────

export function buildFamilyBlock(persons: any[], children: any[]): string {
  if (!persons?.length && !children?.length) return '';

  const spouse = persons?.find(p => p.type === 'spouse');
  const parents = persons?.filter(p => p.type === 'parent');
  const lines: string[] = [];

  if (spouse) lines.push(`Cônjuge: ${spouse.name}`);

  if (children?.length) {
    const childLines = children.map((c: any) => {
      const name = c.nickname || c.name;
      const age = c.birth_date
        ? Math.floor((Date.now() - new Date(c.birth_date).getTime()) / 31557600000)
        : null;
      const ageStr = age !== null ? ` (${age} anos)` : '';
      const otherParent = c.other_parent_name ? `, filho(a) também de ${c.other_parent_name}` : '';
      return `${name}${ageStr}${otherParent}`;
    });
    lines.push(`Filhos: ${childLines.join('; ')}`);
  }

  if (parents?.length) lines.push(`Pais: ${parents.map((p: any) => p.name).join(', ')}`);

  return lines.length ? `[FAMÍLIA]\n${lines.join('\n')}` : '';
}

// ── Perfil pessoal ────────────────────────────────────────────────────────────

export function buildProfileBlock(profile: any): string {
  if (!profile) return '';

  const lines: string[] = [];

  if (profile.full_name) {
    let nameLine = `Nome Completo: ${profile.full_name}`;
    if (profile.gender) nameLine += ` (Gênero: ${profile.gender})`;
    lines.push(nameLine);
  } else if (profile.gender) {
    lines.push(`Gênero: ${profile.gender}`);
  }

  if (profile.birth_date || profile.birth_city || profile.birth_state) {
    const location = [profile.birth_city, profile.birth_state].filter(Boolean).join(', ');
    let nascimentoStr = '';

    if (profile.birth_date) {
      const dateString = profile.birth_date.split('T')[0];
      const [year, month, day] = dateString.split('-');
      const birthDateObj = new Date(Number(year), Number(month) - 1, Number(day));
      const today = new Date();

      let age = today.getFullYear() - birthDateObj.getFullYear();
      const monthDiff = today.getMonth() - birthDateObj.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDateObj.getDate())) age--;

      nascimentoStr += `${day}/${month}/${year} (${age} anos)`;
    }

    if (location) nascimentoStr += nascimentoStr ? ` em ${location}` : location;
    lines.push(`Nascimento: ${nascimentoStr}`);
  }

  if (profile.city || profile.state)
    lines.push(`Residência Atual: ${[profile.city, profile.state].filter(Boolean).join(', ')}`);

  if (profile.whatsapp || profile.phone)
    lines.push(`Contato: ${[profile.whatsapp, profile.phone].filter(Boolean).join(' / ')}`);

  const parents = [profile.father_name, profile.mother_name].filter(Boolean);
  if (parents.length > 0 || profile.siblings_count !== null || profile.spouse_name) {
    const familyBase = [];
    if (profile.spouse_name) familyBase.push(`Cônjuge: ${profile.spouse_name}`);
    if (parents.length > 0) familyBase.push(`Pais: ${parents.join(' e ')}`);
    if (profile.siblings_count !== null && profile.siblings_count !== undefined)
      familyBase.push(`Irmãos: ${profile.siblings_count}`);
    if (familyBase.length > 0)
      lines.push(`Estrutura Familiar Base: ${familyBase.join(' | ')}`);
  }

  if (profile.faith_profile && profile.faith_profile !== 'unknown') {
    let faithStr = `Perfil de Fé: ${profile.faith_profile}`;
    if (profile.faith_notes) faithStr += ` — Notas: ${profile.faith_notes}`;
    lines.push(faithStr);
  }

  if (profile.education_level || profile.schools?.length) {
    let eduStr = `Escolaridade: ${profile.education_level || 'Não informado'}`;
    if (profile.schools?.length) eduStr += ` (Instituições: ${profile.schools.join(', ')})`;
    lines.push(eduStr);
  }

  const jobInfo = [profile.profession, profile.current_job, profile.company].filter(Boolean);
  if (jobInfo.length > 0) {
    let jobStr = `Atuação Profissional: ${jobInfo.join(' — ')}`;
    if (profile.job_start_date) {
      const [sYear, sMonth, sDay] = profile.job_start_date.split('T')[0].split('-');
      jobStr += ` (Desde: ${sDay}/${sMonth}/${sYear})`;
    }
    lines.push(jobStr);
  }

  if (profile.career_notes) lines.push(`Notas de Carreira: ${profile.career_notes}`);
  if (profile.personality_notes) lines.push(`Personalidade: ${profile.personality_notes}`);

  return lines.length ? `[PERFIL PESSOAL]\n${lines.join('\n')}` : '';
}

// ── Resumo de conversa ────────────────────────────────────────────────────────
//
// Mostra as últimas 6 mensagens com marcação clara de "MAIS RECENTE".
// O separador --- entre turnos mais antigos e recentes ajuda o LLM
// a entender que o tópico ativo é o das últimas mensagens,
// não o do início da sessão.

export function buildConversationSummary(
  recentHistory: Array<{ role: string; content: string }>,
  nickname: string,
): string {
  if (!recentHistory?.length) return '';

  const msgs = recentHistory.slice(-6);
  const total = msgs.length;

  // Divide em contexto anterior (mais antigo) e troca atual (mais recente)
  const older  = msgs.slice(0, Math.max(0, total - 2));
  const recent = msgs.slice(-2);

  const format = (m: { role: string; content: string }) => {
    const who = m.role === 'user' ? nickname : 'Lev';
    return `${who}: ${m.content.slice(0, 200)}`;
  };

  const parts: string[] = [];

  if (older.length) {
    parts.push('[HISTÓRICO ANTERIOR — contexto de fundo, não necessariamente o assunto atual]');
    parts.push(older.map(format).join('\n'));
  }

  if (recent.length) {
    parts.push('[TROCA MAIS RECENTE — este é o assunto ativo agora]');
    parts.push(recent.map(format).join('\n'));
  }

  return parts.join('\n');
}

// ── Recomendações ─────────────────────────────────────────────────────────────

export function buildRecommendationsBlock(masterContext: any): string {
  const recs = masterContext?.recommendations || [];
  if (!recs.length) return '';

  const valid = recs.filter((r: any) => r.status !== 'disliked').slice(0, 30);
  if (!valid.length) return '';

  const lines = valid.map((r: any) => `- [${r.type}] ${r.name} (${r.source})`);
  return `[RECOMENDAÇÕES]\n${lines.join('\n')}`;
}

// ── Tópicos recorrentes ───────────────────────────────────────────────────────

export function buildTopicBlock(masterContext: any): string {
  const topics = masterContext?.topics || [];
  if (!topics.length) return '';

  const lines = topics.slice(0, 5).map((t: any) => `- [${t.label}] ${t.topic}`);
  return `[TÓPICOS RECORRENTES]\n${lines.join('\n')}`;
}

// ── Filtro de L3 ──────────────────────────────────────────────────────────────

export function filterL3Content(content: string, includeFamily: boolean): string {
  if (!content) return '';
  if (includeFamily) return content;
  return content
    .replace(/##\s*(datas?|aniversário|família|cônjuge|esposa|filho)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
    .trim();
}

// ── Tópicos relacionados ──────────────────────────────────────────────────────

export function buildRelatedTopicsString(masterContext: any): string {
  return (masterContext?.related_topics || [])
    .map((t: any) => `- ${t.topic} (peso: ${Math.round((t.weight || 0) * 100)}%)`)
    .join('\n');
}

// ── Urgentes ──────────────────────────────────────────────────────────────────

export function buildUrgentesString(masterContext: any): string {
  return (masterContext?.reminders || [])
    .map((u: any) => u.title)
    .filter(Boolean)
    .join(', ');
}

// ── Guidelines ────────────────────────────────────────────────────────────────

export function buildGuidelinesString(masterContext: any): string {
  return (masterContext?.guidelines || [])
    .map((g: any) => g.content)
    .filter(Boolean)
    .join('; ') || 'Progresso contínuo';
}
