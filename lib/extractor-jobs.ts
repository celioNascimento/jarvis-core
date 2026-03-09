// ============================================================
// lib/extractor-jobs.ts
// Parte 2: extratores de jobs, L3 e helpers compartilhados
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { safeParseJSON } from './extractor';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

// ============================================================
// EXTRATOR: PROJETOS → projects
// ============================================================

export async function extractProjeto(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia projetos ou ideias afirmados pelo USUÁRIO.
Retorne APENAS JSON:

Mensagem do usuário: "${userMessage}"

{"projetos": [{"nome": null, "tag": null, "descricao": null, "status": null, "contexto_tecnico": null}]}

REGRAS:
- tag: slug lowercase sem espacos. USE a SIGLA quando houver: "PQF (Procuro Quem Faca)" -> tag="pqf"
- sigla entre parenteses e nome completo = UM UNICO projeto, nao dois
  "PQF (Procuro Quem Faca)" -> nome="PQF", tag="pqf", descricao="Procuro Quem Faca"
  "Procuro Quem Faca (PQF)" -> nome="PQF", tag="pqf", descricao="Procuro Quem Faca"
- status: "ideia"|"em_desenvolvimento"|"beta"|"producao"|"pausado"
- Retorne projetos: [] se nenhum mencionado`;

  try {
    const raw = await callAI(prompt, 300);
    const data = safeParseJSON(raw);
    if (!data) { console.error('[Extrator/projeto] JSON inválido:', raw.slice(0, 100)); return; }
    for (const proj of (data.projetos || [])) {
      if (!proj.nome || !proj.tag) continue;

      // Busca projeto existente para nao sobrescrever com null
      const { data: existing } = await supabase.from('projects')
        .select('description, context_technical, status')
        .eq('user_id', userId).eq('tag', proj.tag).maybeSingle();

      const payload: Record<string, any> = {
        user_id: userId, tag: proj.tag, name: proj.nome,
        updated_at: new Date().toISOString(),
      };

      // Descricao: aceita se nao tinha, ou se a nova for mais longa
      if (proj.descricao) {
        if (!existing?.description || proj.descricao.length > existing.description.length) {
          payload.description = proj.descricao;
        }
      }
      // context_technical: aceita se nao tinha
      if (proj.contexto_tecnico && !existing?.context_technical) {
        payload.context_technical = proj.contexto_tecnico;
      }
      // status: aceita sempre que vier preenchido
      if (proj.status) payload.status = proj.status;

      const { error } = await supabase.from('projects').upsert(payload, { onConflict: 'user_id,tag' });
      if (error) console.error('[Extrator/projeto] Erro:', error);
      else console.log('[Extrator/projeto]', proj.nome);
    }
  } catch (e) { console.error('[Extrator/projeto] Erro:', e); }
}

// ============================================================
// EXTRATOR: EVENTOS → events
// ============================================================

const EVENT_WEIGHTS: Record<string, { priority: string; decay_type: string; emotional_weight: number }> = {
  aniversario_proprio:   { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 1.00 },
  aniversario_casamento: { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 1.00 },
  aniversario_esposa:    { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.95 },
  aniversario_marido:    { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.95 },
  aniversario_filho:     { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.90 },
  aniversario_familiar:  { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.80 },
  aniversario_amigo:     { priority: 'media', decay_type: 'recurring_annual', emotional_weight: 0.50 },
  natal:                 { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.85 },
  pascoa:                { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.80 },
  ano_novo:              { priority: 'media', decay_type: 'recurring_annual', emotional_weight: 0.60 },
  festa_escola:          { priority: 'media', decay_type: 'one_time',         emotional_weight: 0.60 },
  evento_escolar:        { priority: 'media', decay_type: 'one_time',         emotional_weight: 0.55 },
  consulta_medica:       { priority: 'alta',  decay_type: 'deadline',         emotional_weight: 0.70 },
  compromisso_trabalho:  { priority: 'media', decay_type: 'deadline',         emotional_weight: 0.40 },
  entrega_projeto:       { priority: 'alta',  decay_type: 'deadline',         emotional_weight: 0.60 },
  inicio_emprego:        { priority: 'media', decay_type: 'one_time',         emotional_weight: 0.50 },
  default:               { priority: 'media', decay_type: 'one_time',         emotional_weight: 0.50 },
};

export async function extractEvento(userId: string, userMessage: string): Promise<void> {
  const anoAtual = new Date().getFullYear();
  const prompt = `Extraia eventos ou datas comemorativas (SEM hora específica) mencionados pelo USUÁRIO.

Mensagem do usuário: "${userMessage}"

Retorne APENAS JSON:
{"eventos": [{"titulo": null, "data": null, "tipo": null, "recorrente": false, "notas": null}]}

Tipos: aniversario_proprio|aniversario_esposa|aniversario_filho|aniversario_familiar|
       aniversario_casamento|aniversario_amigo|natal|pascoa|festa_escola|
       compromisso_trabalho|entrega_projeto|default

REGRAS de título — SEMPRE inferir, nunca retornar null:
- "aniversário de casamento é dia 13 de dezembro" → titulo: "Aniversário de Casamento"
- "meu aniversário é dia 27 de setembro" → titulo: "Aniversário Celio" — SEMPRE com o primeiro nome
- "nasci em 27/09/1985" → titulo: "Aniversário Celio" — NUNCA só "Aniversário"
- "todo natal a gente se reúne" → titulo: "Natal em família"
- "páscoa em família todo ano" → titulo: "Páscoa em família"
- "aniversário da Giselle" → titulo: "Aniversário Giselle"
- Se não houver título explícito, infere pelo contexto — NUNCA retorne titulo: null
- "aniversário de casamento" → titulo: "Aniversário de Casamento" — NUNCA "Meu Aniversário"
- "aniversário de casamento" e "meu aniversário" são EVENTOS DISTINTOS — gere dois objetos separados se ambos mencionados
- Aniversário próprio SEMPRE inclui o primeiro nome: "Aniversário Celio", nunca "Meu Aniversário" ou só "Aniversário"

REGRAS de conversão de data para YYYY-MM-DD:
- "13 de dezembro de 2014" → 2014-12-13
- "dia 13 de dezembro" → ${anoAtual}-12-13
- "todo natal" → ${anoAtual}-12-25
- "páscoa todo ano" → ${anoAtual}-04-05
- "todo ano novo" → ${anoAtual}-01-01
- Ano corrente = ${anoAtual}

REGRAS de recorrente:
- Aniversários, natal, páscoa, ano novo → recorrente: true
- Entregas, deadlines, eventos únicos → recorrente: false

Retorne eventos: [] se nenhuma data ou evento mencionado`;

  try {
    const raw = await callAI(prompt, 300);
    console.log('[Extrator/evento] raw:', raw.slice(0, 200));
    const data = JSON.parse(raw);
    for (const ev of (data.eventos || [])) {
      if (!ev.titulo || !ev.data) continue;
      const w = EVENT_WEIGHTS[ev.tipo] || EVENT_WEIGHTS.default;
      await upsertEvent(userId, {
        title: ev.titulo, event_date: ev.data,
        category: getCategoryFromType(ev.tipo),
        is_recurring: ev.recorrente ?? w.decay_type === 'recurring_annual',
        notes: ev.notas || null, ...w,
      });
      console.log('[Extrator/evento]', ev.titulo);
    }
  } catch (e) { console.error('[Extrator/evento] Erro:', e); }
}

// ============================================================
// EXTRATOR: AGENDA → agenda
// ============================================================

export async function extractAgenda(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia compromissos com data E hora explícitas mencionados pelo USUÁRIO.
Retorne APENAS JSON:

Mensagem do usuário: "${userMessage}"

{"compromissos": [{"descricao": null, "data_hora": null, "categoria": null}]}

data_hora: ISO 8601 fuso -03:00 (ex: "2026-03-10T10:00:00-03:00")
Categorias: Saúde|Trabalho|Escola|Família|Pessoal|Rotina
Retorne compromissos: [] se nenhum mencionado`;

  try {
    const raw = await callAI(prompt, 250);
    const data = safeParseJSON(raw);
    if (!data) { console.error('[Extrator/agenda] JSON inválido:', raw.slice(0, 100)); return; }
    for (const comp of (data.compromissos || [])) {
      if (!comp.descricao || !comp.data_hora) continue;
      const { data: ex } = await supabase.from('agenda').select('id')
        .eq('user_id', userId).eq('description', comp.descricao).eq('event_at', comp.data_hora).maybeSingle();
      if (!ex) {
        await supabase.from('agenda').insert({
          user_id: userId, description: comp.descricao,
          event_at: comp.data_hora, category: comp.categoria || 'Pessoal',
        });
        console.log('[Extrator/agenda]', comp.descricao);
      }
    }
  } catch (e) { console.error('[Extrator/agenda] Erro:', e); }
}

// ============================================================
// EXTRATOR: ROTINA → user_profiles.personality_notes
// ============================================================

export async function extractRotina(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia informações de rotina afirmadas pelo USUÁRIO.
Retorne APENAS JSON (null para não mencionados):

Mensagem do usuário: "${userMessage}"

{"despertar": null, "dormir": null, "academia_horario": null, "trabalho_entrada": null, "trabalho_saida": null, "lembretes": []}`;

  try {
    const raw = await callAI(prompt, 200);
    const data = safeParseJSON(raw);
    if (!data) { console.error('[Extrator/rotina] JSON inválido:', raw.slice(0, 100)); return; }
    const parts: string[] = [];
    if (data.despertar)        parts.push(`Despertar: ${data.despertar}`);
    if (data.dormir)           parts.push(`Dormir: ${data.dormir}`);
    if (data.academia_horario) parts.push(`Academia: ${data.academia_horario}`);
    if (data.trabalho_entrada) parts.push(`Entrada: ${data.trabalho_entrada}`);
    if (data.trabalho_saida)   parts.push(`Saída: ${data.trabalho_saida}`);
    if (data.lembretes?.length) parts.push(`Lembretes: ${data.lembretes.join(', ')}`);
    if (parts.length === 0) return;

    const { data: prof } = await supabase.from('user_profiles')
      .select('personality_notes').eq('user_id', userId).maybeSingle();
    const old      = prof?.personality_notes || '';
    const newBlock = `[ROTINA] ${parts.join(' | ')}`;
    const updated  = /\[ROTINA\]/i.test(old)
      ? old.replace(/\[ROTINA\][^\n]*/i, newBlock)
      : `${old}\n${newBlock}`.trim();

    await supabase.from('user_profiles').upsert(
      { user_id: userId, personality_notes: updated, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
    console.log('[Extrator/rotina]', parts.join(' | '));
  } catch (e) { console.error('[Extrator/rotina] Erro:', e); }
}

// ============================================================
// EXTRATOR: PREFERÊNCIAS → user_profiles.career_notes
// ============================================================

export async function extractPreferencia(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia preferências pessoais afirmadas pelo USUÁRIO.
Retorne APENAS JSON:

Mensagem do usuário: "${userMessage}"

{"preferencias": [{"tipo": "lugar", "descricao": "Feira do Produtor aos sábados"}]}

Tipos: lugar|comida|filme|musica|esporte|hobby|outro
Retorne preferencias: [] se nenhuma mencionada`;

  try {
    const raw  = await callAI(prompt, 200);
    const data = safeParseJSON(raw);
    if (!data) { console.error('[Extrator/preferencia] JSON inválido:', raw.slice(0, 100)); return; }
    const prefs: any[] = data.preferencias || [];
    if (prefs.length === 0) return;

    const { data: prof } = await supabase.from('user_profiles')
      .select('career_notes').eq('user_id', userId).maybeSingle();
    const old     = prof?.career_notes || '';
    const newLine = prefs.map((p: any) => `[${p.tipo}] ${p.descricao}`).join(' | ');
    // Evita duplicar preferências já registradas
    const alreadyExists = prefs.every((p: any) => old.includes(p.descricao));
    if (alreadyExists) return;
    const updated = old ? `${old} | ${newLine}` : newLine;

    await supabase.from('user_profiles').upsert(
      { user_id: userId, career_notes: updated, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
    console.log('[Extrator/preferencia]', newLine);
  } catch (e) { console.error('[Extrator/preferencia] Erro:', e); }
}

// ============================================================
// ATUALIZA L3 — users.current_context
// Inclui todos os campos relevantes do perfil
// ============================================================

export async function updateL3(userId: string): Promise<void> {
  try {
    const [profRes, kidsRes, projRes, evRes, userRes] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('children').select('name, birth_date, life_phase, gender').eq('parent_id', userId),
      supabase.from('projects').select('name, description, status').eq('user_id', userId).limit(10),
      supabase.from('events').select('title, event_date, emotional_weight')
        .eq('user_id', userId).order('event_date').limit(10),
      supabase.from('users').select('current_context').eq('id', userId).single(),
    ]);

    const p    = profRes.data;
    const kids = kidsRes.data || [];
    const proj = projRes.data || [];
    const evs  = evRes.data || [];
    let   ctx  = userRes.data?.current_context || '';

    const patches: Record<string, string> = {};

    // Identidade
    if (p?.full_name) {
      patches['Nome'] = p.preferred_name
        ? `${p.full_name} (prefere: ${p.preferred_name})`
        : p.full_name;
    }
    if (p?.gender)        patches['Gênero']      = p.gender;
    if (p?.birth_date)    patches['Nascimento']  = p.birth_date;

    // Localização
    if (p?.city)          patches['Mora em']     = `${p.city}${p.state ? `, ${p.state}` : ''}`;
    if (p?.birth_city)    patches['Nasceu em']   = `${p.birth_city}${p.birth_state ? `, ${p.birth_state}` : ''}`;

    // Contato
    if (p?.phone)         patches['Telefone']    = p.phone;
    if (p?.whatsapp)      patches['WhatsApp']    = p.whatsapp;

    // Família
    if (p?.spouse_name)   patches['Cônjuge']     = `${p.spouse_name}${p.spouse_birthday ? ` (aniv: ${p.spouse_birthday})` : ''}`;
    if (p?.father_name)   patches['Pai']         = p.father_name;
    if (p?.mother_name)   patches['Mãe']         = p.mother_name;
    if (p?.siblings_count !== null && p?.siblings_count !== undefined) {
      patches['Irmãos'] = String(p.siblings_count);
    }

    // Carreira
    if (p?.profession)    patches['Formação']    = p.profession;
    if (p?.current_job)   patches['Cargo']       = [
      p.current_job,
      p.company    ? `@ ${p.company}` : null,
      p.job_start_date ? `(início: ${p.job_start_date})` : null,
    ].filter(Boolean).join(' ');

    // Educação
    if (p?.education_level) patches['Escolaridade'] = p.education_level;
    if (p?.schools?.length) patches['Escolas']      = p.schools.join(', ');

    // Fé
    if (p?.faith_profile && p.faith_profile !== 'unknown') patches['Fé'] = p.faith_profile;

    // Filhos
    if (kids.length > 0) {
      patches['Filhos'] = kids.map((k: any) => {
        const age = k.birth_date
          ? new Date().getFullYear() - new Date(k.birth_date).getFullYear()
          : null;
        return `${k.name}${age ? ` (${age} anos)` : ''}${k.gender ? ` [${k.gender}]` : ''}`;
      }).join(', ');
    }

    // Aplica patches no contexto — só substitui se o valor mudou
    const changed: string[] = [];
    for (const [key, val] of Object.entries(patches)) {
      const rx      = new RegExp(`- ${key}: (.*)`, 'i');
      const match   = ctx.match(rx);
      const current = match?.[1]?.trim() || '';
      if (current === val) continue; // nada mudou — pula
      const line = `- ${key}: ${val}`;
      ctx = match ? ctx.replace(rx, line) : `${ctx}\n${line}`;
      changed.push(key);
    }

    // Seção projetos — só atualiza se mudou
    if (proj.length > 0) {
      const block      = proj.map((r: any) => `- ${r.name}${r.status ? ` [${r.status}]` : ''}: ${r.description || ''}`).join('\n');
      const section    = `## PROJETOS\n${block}`;
      const existProj  = /## PROJETOS[\s\S]*?(?=\n##|$)/i.exec(ctx)?.[0] || '';
      if (existProj !== section) {
        ctx = existProj
          ? ctx.replace(/## PROJETOS[\s\S]*?(?=\n##|$)/i, section)
          : `${ctx}\n\n${section}`;
        changed.push('Projetos');
      }
    }

    // Seção datas importantes — só atualiza se mudou
    const highEvs = evs.filter((e: any) => (e.emotional_weight || 0) >= 0.7);
    if (highEvs.length > 0) {
      const block      = highEvs.map((e: any) => `- ${e.title}: ${e.event_date}`).join('\n');
      const section    = `## DATAS IMPORTANTES\n${block}`;
      const existDatas = /## DATAS IMPORTANTES[\s\S]*?(?=\n##|$)/i.exec(ctx)?.[0] || '';
      if (existDatas !== section) {
        ctx = existDatas
          ? ctx.replace(/## DATAS IMPORTANTES[\s\S]*?(?=\n##|$)/i, section)
          : `${ctx}\n\n${section}`;
        changed.push('Datas');
      }
    }

    // Só faz update se algo realmente mudou
    if (changed.length === 0) {
      console.log('[Extrator/L3] Sem mudanças — update ignorado');
      return;
    }

    const { error } = await supabase.from('users')
      .update({ current_context: ctx.trim() }).eq('id', userId);
    if (error) console.error('[Extrator/L3] Erro:', error);
    else console.log('[Extrator/L3] Mudanças:', changed.join(', '));
  } catch (e) { console.error('[Extrator/L3] Erro:', e); }
}

// ============================================================
// HELPERS COMPARTILHADOS — exportados para extractor.ts
// ============================================================

export async function callAI(prompt: string, maxTokens = 300): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('[callAI] Nenhuma API key encontrada (OPENAI_API_KEY ou OPENROUTER_API_KEY)');
    throw new Error('API key ausente');
  }
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.0-flash-001',
      max_tokens: maxTokens,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('[callAI] HTTP erro:', res.status, err.slice(0, 200));
    throw new Error(`callAI HTTP ${res.status}`);
  }
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
  if (!text) {
    console.error('[callAI] Resposta vazia:', JSON.stringify(data).slice(0, 200));
    throw new Error('callAI resposta vazia');
  }
  return text;
}

export async function upsertAlias(
  userId: string, alias: string, type: string,
  referId: string | null, referName: string | null
): Promise<void> {
  await supabase.from('contact_aliases').upsert({
    user_id:        userId,
    alias:          alias.toLowerCase().trim(),
    refers_to_type: type,
    refers_to_id:   referId,
    refers_to_name: referName,
    updated_at:     new Date().toISOString(),
  }, { onConflict: 'user_id,alias' });
}

// Normaliza título de evento para comparação e persistência
function normalizeEventTitle(t: string): string {
  const s = t.trim();
  // Títulos compostos com "de" — preserva inteiro: "Aniversário de Casamento"
  if (/^aniversári[oa]?\s+de\s+\w/i.test(s)) return s;
  // Remove "da/do" após aniversário: "Aniversário da Giselle" → "Aniversário Giselle"
  const sem_da = s.replace(/^(aniversári[oa]?\s+)(d[ao]\s+)/gi, '$1');
  // Mantém só o primeiro nome após "Aniversário": "Aniversário Celio Roberto" → "Aniversário Celio"
  return sem_da
    .replace(/^(aniversári[oa]?\s+)(\S+)(\s+\S+)+$/gi, (_, prefix, first) => `${prefix}${first}`)
    .trim();
}

// Normaliza título genérico para deduplicação fuzzy
// "Início na White Martins", "Começo White Martins", "Início White Martins",
// "Novo emprego White Martins" → mesmo cluster pela empresa/keyword principal
function fuzzyTitleKey(t: string): string {
  return t.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // Normaliza prefixos de início de emprego
    .replace(/^(inicio|começo|comeco|novo emprego|start|entrada)\s+(na?|em|no|ao)?\s*/i, 'inicio ')
    // Normaliza "Aniversário X Y" → "aniversario X" (já feito pelo normalizeEventTitle, mas reforça)
    .replace(/^(aniversari[oa]?)\s+(de\s+)?/i, 'aniversario ')
    .replace(/\s+/g, ' ').trim();
}

// Cache local em memória para evitar duplo insert na mesma sessão Node
const recentInserts = new Map<string, number>();

export async function upsertEvent(userId: string, ev: {
  title: string; event_date: string; category: string;
  priority: string; decay_type: string; emotional_weight: number;
  is_recurring?: boolean; notes?: string | null;
}): Promise<void> {
  const title = normalizeEventTitle(ev.title);

  // Rejeita títulos genéricos demais — sem contexto suficiente para deduplicar
  const titulosRejeitados = /^(aniversário|aniversario|evento|compromisso|data|lembrete)$/i;
  if (titulosRejeitados.test(title.trim())) {
    console.log('[upsertEvent] Rejeitado (título genérico):', title);
    return;
  }

  // Normaliza para comparação local: sem acentos, lowercase
  const norm = (s: string) => s.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');

  // Chave de deduplicação: user + título fuzzy + mês/dia
  const mmdd      = ev.event_date.slice(5); // MM-DD
  const titleKey  = fuzzyTitleKey(title);
  const dedupKey  = `${userId}:${titleKey}:${mmdd}`;

  // Verifica cache local — se inserimos nos últimos 10s, ignora
  const lastInsert = recentInserts.get(dedupKey) || 0;
  if (Date.now() - lastInsert < 10_000) {
    console.log('[upsertEvent] Ignorado (cache):', title);
    return;
  }

  // Busca no banco por mês/dia (uma única query)
  const { data: candidates } = await supabase.from('events')
    .select('id, title, priority, emotional_weight, notes, decay_type, is_recurring')
    .eq('user_id', userId)
    .like('event_date', `%-${mmdd}`);

  const ex = (candidates || []).find((c: any) => {
    const cn = norm(normalizeEventTitle(c.title));
    const tn = norm(title);
    // Match exato normalizado
    if (cn === tn) return true;
    // Match fuzzy: mesmo cluster de título (ex: "início" vs "começo")
    if (fuzzyTitleKey(c.title) === titleKey) return true;
    // Match por primeiro token após "aniversário" (ex: "Celio")
    const cf = cn.replace(/aniversari[oa]?\s+(de\s+)?/, '').split(' ')[0];
    const tf = tn.replace(/aniversari[oa]?\s+(de\s+)?/, '').split(' ')[0];
    return tf.length > 2 && cf === tf;
  });

  recentInserts.set(dedupKey, Date.now());

  if (ex?.id) {
    // Só atualiza se o novo dado for de maior qualidade
    const betterPriority   = ev.priority === 'alta' && ex.priority !== 'alta';
    const betterWeight     = ev.emotional_weight > (ex.emotional_weight || 0);
    const hasNewNote       = ev.notes && !ex.notes;
    const titleImproved    = norm(title) !== norm(ex.title); // normalização melhorou

    if (!betterPriority && !betterWeight && !hasNewNote && !titleImproved) {
      console.log('[upsertEvent] Ignorado (sem melhoria):', title);
      return;
    }
    await supabase.from('events').update({
      title,
      ...(betterPriority  ? { priority: ev.priority }                  : {}),
      ...(betterWeight    ? { emotional_weight: ev.emotional_weight }   : {}),
      ...(hasNewNote      ? { notes: ev.notes }                         : {}),
    }).eq('id', ex.id);
    console.log('[upsertEvent] Atualizado:', title);
  } else {
    await supabase.from('events').insert({
      user_id: userId, title, event_date: ev.event_date,
      category: ev.category, priority: ev.priority, decay_type: ev.decay_type,
      emotional_weight: ev.emotional_weight,
      is_recurring: ev.is_recurring ?? ev.decay_type === 'recurring_annual',
      notes: ev.notes || null,
      last_notified_year: new Date().getFullYear() - 1,
      relevance_score: 1.0,
    });
    console.log('[upsertEvent] Inserido:', title);
  }
}

export function normalizeDate(raw: string): string {
  if (!raw) return raw;
  const months: Record<string, string> = {
    janeiro:'01', fevereiro:'02', marco:'03', abril:'04',
    maio:'05', junho:'06', julho:'07', agosto:'08',
    setembro:'09', outubro:'10', novembro:'11', dezembro:'12',
  };
  const currentYear = new Date().getFullYear();

  // "5 de agosto" ou "5 de agosto de 2020"
  const ptMatch = raw.match(/(\d{1,2})\s+de?\s+(\w+)(\s+de?\s+(\d{4}))?/i);
  if (ptMatch) {
    const mon  = months[ptMatch[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')];
    const year = ptMatch[4] || String(currentYear);
    if (mon) return `${year}-${mon}-${ptMatch[1].padStart(2, '0')}`;
  }

  const parts = raw.split(/[-/]/);

  if (parts.length === 3) {
    const [a, b, c] = parts;
    // YYYY-MM-DD já correto
    if (a.length === 4) return `${a}-${b.padStart(2,'0')}-${c.padStart(2,'0')}`;
    // DD/MM/YYYY → YYYY-MM-DD
    if (c.length === 4) return `${c}-${b.padStart(2,'0')}-${a.padStart(2,'0')}`;
    // DD/MM/YY → 20YY-MM-DD
    if (c.length === 2) return `20${c}-${b.padStart(2,'0')}-${a.padStart(2,'0')}`;
  }

  // DD/MM → ano corrente
  if (parts.length === 2) {
    return `${currentYear}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
  }

  return raw;
}

export function getCategoryFromType(tipo: string): string {
  if (/escola|escolar/.test(tipo))       return 'school';
  if (/medic|saude/.test(tipo))          return 'health';
  if (/trabalho|projeto/.test(tipo))     return 'work';
  if (/aniversario|familiar/.test(tipo)) return 'family';
  return 'personal';
}

export function getLifePhase(age: number | null): string {
  if (age === null || age === undefined || age < 0) return 'child';
  if (age < 3)   return 'baby';
  if (age <= 11) return 'child';
  if (age <= 17) return 'teen';
  if (age <= 24) return 'young_adult';
  return 'adult';
}