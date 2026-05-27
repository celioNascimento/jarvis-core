// lib/chat/pipeline/formatters/index.ts
//
// Funções PURAS de formatação — recebem dados, devolvem string.
// Sem I/O, sem LLM, sem banco. Testáveis unitariamente.
// Extraídas do prompt-assembler.ts original.

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

  // 1. Identidade e Gênero
  if (profile.full_name) {
    let nameLine = `Nome Completo: ${profile.full_name}`;
    if (profile.gender) nameLine += ` (Gênero: ${profile.gender})`;
    lines.push(nameLine);
  } else if (profile.gender) {
    lines.push(`Gênero: ${profile.gender}`);
  }

  // 2. Nascimento e Idade (cálculo dinâmico seguro)
  if (profile.birth_date || profile.birth_city || profile.birth_state) {
    const location = [profile.birth_city, profile.birth_state].filter(Boolean).join(', ');
    let nascimentoStr = '';

    if (profile.birth_date) {
      const dateObj = new Date(new Date(profile.birth_date).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const age = Math.floor((Date.now() - dateObj.getTime()) / 31557600000);
      nascimentoStr += `${dateObj.toLocaleDateString('pt-BR')} (${age} anos)`;
    }

    if (location) {
      nascimentoStr += nascimentoStr ? ` em ${location}` : location;
    }

    lines.push(`Nascimento: ${nascimentoStr}`);
  }

  // 3. Localização Atual
  if (profile.city || profile.state) {
    lines.push(`Residência Atual: ${[profile.city, profile.state].filter(Boolean).join(', ')}`);
  }

  // 4. Contato
  if (profile.whatsapp || profile.phone) {
    lines.push(`Contato: ${[profile.whatsapp, profile.phone].filter(Boolean).join(' / ')}`);
  }

  // 5. Estrutura Familiar Base (Atua como redundância/complemento ao familyBlock)
  const parents = [profile.father_name, profile.mother_name].filter(Boolean);
  if (parents.length > 0 || profile.siblings_count !== null || profile.spouse_name) {
    const familyBase = [];
    if (profile.spouse_name) familyBase.push(`Cônjuge: ${profile.spouse_name}`);
    if (parents.length > 0) familyBase.push(`Pais: ${parents.join(' e ')}`);
    if (profile.siblings_count !== null && profile.siblings_count !== undefined) familyBase.push(`Irmãos: ${profile.siblings_count}`);

    if (familyBase.length > 0) {
      lines.push(`Estrutura Familiar Base: ${familyBase.join(' | ')}`);
    }
  }

  // 6. Crenças e Fé
  if (profile.faith_profile && profile.faith_profile !== 'unknown') {
    let faithStr = `Perfil de Fé: ${profile.faith_profile}`;
    if (profile.faith_notes) faithStr += ` — Notas: ${profile.faith_notes}`;
    lines.push(faithStr);
  }

  // 7. Educação
  if (profile.education_level || (profile.schools && profile.schools.length > 0)) {
    let eduStr = `Escolaridade: ${profile.education_level || 'Não informado'}`;
    if (profile.schools && profile.schools.length > 0) {
      eduStr += ` (Instituições: ${profile.schools.join(', ')})`;
    }
    lines.push(eduStr);
  }

  // 8. Profissão, Cargo Atual e Empresa
  const jobInfo = [profile.profession, profile.current_job, profile.company].filter(Boolean);
  if (jobInfo.length > 0) {
    let jobStr = `Atuação Profissional: ${jobInfo.join(' — ')}`;

    if (profile.job_start_date) {
      const startDate = new Date(new Date(profile.job_start_date).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      jobStr += ` (Desde: ${startDate.toLocaleDateString('pt-BR')})`;
    }
    lines.push(jobStr);
  }

  if (profile.career_notes)
    lines.push(`Notas de Carreira: ${profile.career_notes}`);

  if (profile.personality_notes)
    lines.push(`Personalidade: ${profile.personality_notes}`);

  return lines.length ? `[PERFIL PESSOAL]\n${lines.join('\n')}` : '';
}

// ── Resumo de conversa ────────────────────────────────────────────────────────

export function buildConversationSummary(
  recentHistory: Array<{ role: string; content: string }>,
  nickname: string,
): string {
  if (!recentHistory?.length) return '';
  return recentHistory
    .slice(-8)
    .map(m => {
      const who = m.role === 'user' ? nickname : 'Lev';
      return `${who}: ${m.content.slice(0, 200)}`;
    })
    .join('\n');
}

// ── Recomendações ─────────────────────────────────────────────────────────────
// Movido de extractor-jobs.ts (buildRecommendationsBlock)

export function buildRecommendationsBlock(masterContext: any): string {
  const recs = masterContext?.recommendations || [];
  if (!recs.length) return '';

  const valid = recs.filter((r: any) => r.status !== 'disliked').slice(0, 30);
  if (!valid.length) return '';

  const lines = valid.map((r: any) => `- [${r.type}] ${r.name} (${r.source})`);
  return `[RECOMENDAÇÕES]\n${lines.join('\n')}`;
}

// ── Tópicos recorrentes ───────────────────────────────────────────────────────
// Movido de extractor-jobs.ts (buildTopicBlock)

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

// ── Tópicos relacionados (formatação inline) ──────────────────────────────────

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