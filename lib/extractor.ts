// ============================================================
// lib/extractor.ts
// Extrator Contínuo de Contexto — Brain como Fonte da Verdade
//
// FLUXO:
//   Brain (mensagem) → Classificador → Extratores especializados
//                                    ↓
//              user_profiles | children | projects | events
//              agenda | relationships | onboarding_progress
//                                    ↓
//                        L3 (current_context) atualizado
//
// USO NO WEBHOOK (após brain.insert):
//   import { extractAndRoute } from '@/lib/extractor';
//   if (category === 'info') {
//     extractAndRoute(userId, authorName, messageText, aiReply)
//       .catch(e => console.error('[Extrator]', e));
//   }
//
// ISOLADO — não altera nenhum arquivo existente
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

// ── Tipagens ─────────────────────────────────────────────────

type Context =
  | 'perfil'        // dados pessoais: nome, cidade, nascimento, profissão
  | 'familia'       // esposa, filhos, pais, irmãos
  | 'projeto'       // projetos, ideias, iniciativas
  | 'evento'        // aniversários, festas, compromissos recorrentes
  | 'agenda'        // agendamentos pontuais com data/hora
  | 'rotina'        // hábitos, horários, lembretes recorrentes
  | 'preferencia'   // gostos, opiniões, jeito de ser
  | 'nenhum';       // conversa sem fato novo

interface ClassificationResult {
  contexts: Context[];
  has_new_facts: boolean;
}

// ── Pesos de evento por tipo ──────────────────────────────────
// Determina prioridade e decay_type baseado no contexto
const EVENT_WEIGHTS: Record<string, { priority: string; decay_type: string; emotional_weight: number }> = {
  // Família próxima — alta prioridade, recorrente anual
  'aniversario_esposa':    { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.95 },
  'aniversario_filho':     { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.90 },
  'aniversario_familiar':  { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.80 },
  // Amigos e escola — média prioridade
  'aniversario_amigo':     { priority: 'media', decay_type: 'recurring_annual', emotional_weight: 0.50 },
  'festa_escola':          { priority: 'media', decay_type: 'one_time',         emotional_weight: 0.60 },
  'evento_escolar':        { priority: 'media', decay_type: 'one_time',         emotional_weight: 0.55 },
  // Trabalho e saúde — prazo definido
  'consulta_medica':       { priority: 'alta',  decay_type: 'deadline',         emotional_weight: 0.70 },
  'compromisso_trabalho':  { priority: 'media', decay_type: 'deadline',         emotional_weight: 0.40 },
  'entrega_projeto':       { priority: 'alta',  decay_type: 'deadline',         emotional_weight: 0.60 },
  // Padrão
  'default':               { priority: 'media', decay_type: 'one_time',         emotional_weight: 0.50 },
};

// ============================================================
// PONTO DE ENTRADA PRINCIPAL
// Chamado pelo webhook após persistência na brain
// ============================================================
export async function extractAndRoute(
  userId: string,      // text (Telegram ID)
  userName: string,
  userMessage: string,
  aiReply: string
): Promise<void> {
  try {
    // Estágio 1: Classificar contextos presentes na troca
    const classification = await classifyMessage(userMessage, aiReply);

    if (!classification.has_new_facts) {
      console.log('[Extrator] Sem fatos novos — skip');
      return;
    }

    console.log('[Extrator] Contextos detectados:', classification.contexts);

    // Estágio 2: Disparar extratores em paralelo por contexto
    const tasks: Promise<any>[] = [];

    if (classification.contexts.includes('perfil')) {
      tasks.push(extractPerfil(userId, userMessage, aiReply));
    }
    if (classification.contexts.includes('familia')) {
      tasks.push(extractFamilia(userId, userMessage, aiReply));
    }
    if (classification.contexts.includes('projeto')) {
      tasks.push(extractProjeto(userId, userMessage, aiReply));
    }
    if (classification.contexts.includes('evento')) {
      tasks.push(extractEvento(userId, userName, userMessage, aiReply));
    }
    if (classification.contexts.includes('agenda')) {
      tasks.push(extractAgenda(userId, userMessage, aiReply));
    }
    if (classification.contexts.includes('rotina')) {
      tasks.push(extractRotina(userId, userMessage, aiReply));
    }
    if (classification.contexts.includes('preferencia')) {
      tasks.push(extractPreferencia(userId, userMessage, aiReply));
    }

    await Promise.allSettled(tasks);

    // Estágio 3: Atualizar L3 consolidando tudo
    await patchL3FromBrain(userId);

  } catch (e) {
    console.error('[Extrator] Erro geral:', e);
  }
}

// ============================================================
// ESTÁGIO 1: CLASSIFICADOR DE CONTEXTO
// Rápido e barato — apenas classifica, não extrai
// ============================================================
async function classifyMessage(
  userMessage: string,
  aiReply: string
): Promise<ClassificationResult> {
  const prompt = `
Analise a troca abaixo e identifique quais contextos têm FATOS NOVOS sendo compartilhados.

Usuário: "${userMessage}"
Assistente: "${aiReply}"

Retorne APENAS JSON:
{
  "has_new_facts": true,
  "contexts": ["perfil", "familia"]
}

Contextos possíveis:
- "perfil": cidade, estado natal, profissão, emprego, data de nascimento
- "familia": esposa/marido (nome, aniversário), filhos (nome, idade), pais, irmãos
- "projeto": projetos, ideias para desenvolver, iniciativas, apps, negócios
- "evento": aniversários de pessoas, festas, datas comemorativas recorrentes
- "agenda": compromissos pontuais com data/hora (consulta, reunião, evento específico)
- "rotina": hábitos fixos, horários de acordar/dormir/treinar, lembretes recorrentes
- "preferencia": gostos, opiniões, lugares favoritos, preferências pessoais

Regras:
- has_new_facts: false se for conversa genérica sem informação pessoal nova
- contexts: lista APENAS os que têm fatos EXPLICITAMENTE mencionados
- Retorne [] e has_new_facts: false para saudações, perguntas gerais, piadas
`;

  try {
    const raw = await callAI(prompt, 200);
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { contexts: [], has_new_facts: false };
  }
}

// ============================================================
// EXTRATOR: PERFIL PESSOAL
// → user_profiles
// ============================================================
async function extractPerfil(
  userId: string,
  userMessage: string,
  aiReply: string
): Promise<void> {
  const prompt = `
Extraia dados de perfil pessoal mencionados explicitamente.
Retorne APENAS JSON (null para não mencionados):

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "cidade": null,
  "estado": null,
  "cidade_natal": null,
  "estado_natal": null,
  "nascimento": null,
  "profissao": null,
  "empresa": null,
  "escolaridade": null,
  "genero": null
}
`;

  try {
    const raw = await callAI(prompt, 300);
    const data = JSON.parse(raw.replace(/```json|```/g, '').trim());

    const patch: Record<string, any> = {};
    if (data.cidade)       patch.city          = data.cidade;
    if (data.estado)       patch.state         = data.estado;
    if (data.cidade_natal) patch.birth_city    = data.cidade_natal;
    if (data.estado_natal) patch.birth_state   = data.estado_natal;
    if (data.nascimento)   patch.birth_date    = data.nascimento;
    if (data.profissao)    patch.current_job   = data.profissao;
    if (data.empresa)      patch.company       = data.empresa;
    if (data.genero) {
      const genMap: Record<string, string> = {
        'masculino': 'masculino', 'homem': 'masculino', 'm': 'masculino',
        'feminino': 'feminino', 'mulher': 'feminino', 'f': 'feminino',
      };
      patch.gender = genMap[data.genero.toLowerCase()] || 'prefiro_nao_dizer';
    }
    if (data.escolaridade) {
      const escMap: Record<string, string> = {
        'fundamental': 'fundamental', 'médio': 'medio', 'técnico': 'tecnico',
        'superior': 'superior_completo', 'faculdade': 'superior_cursando',
        'pós': 'pos_graduacao', 'mestrado': 'mestrado', 'doutorado': 'doutorado',
      };
      for (const [k, v] of Object.entries(escMap)) {
        if (data.escolaridade.toLowerCase().includes(k)) { patch.education_level = v; break; }
      }
    }

    if (Object.keys(patch).length === 0) return;

    patch.user_id    = parseInt(userId);
    patch.updated_at = new Date().toISOString();

    await supabase
      .from('user_profiles')
      .upsert(patch, { onConflict: 'user_id' });

    console.log('[Extrator/perfil] Atualizado:', Object.keys(patch).join(', '));
  } catch (e) {
    console.error('[Extrator/perfil] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: FAMÍLIA
// → user_profiles (esposa), children, relationships
// ============================================================
async function extractFamilia(
  userId: string,
  userMessage: string,
  aiReply: string
): Promise<void> {
  const prompt = `
Extraia dados familiares mencionados explicitamente.
Retorne APENAS JSON (null/[] para não mencionados):

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "esposa": { "nome": null, "aniversario": null },
  "marido": { "nome": null, "aniversario": null },
  "filhos": [{ "nome": "Miguel", "idade": 5, "sexo": "m" }],
  "pais": { "pai": null, "mae": null },
  "irmaos": []
}
`;

  try {
    const raw = await callAI(prompt, 400);
    const data = JSON.parse(raw.replace(/```json|```/g, '').trim());

    // ── Esposa/Marido → personality_notes em user_profiles ──
    const conjuge = data.esposa?.nome ? data.esposa : data.marido?.nome ? data.marido : null;
    if (conjuge?.nome) {
      await supabase
        .from('user_profiles')
        .upsert({
          user_id:     parseInt(userId),
          personality_notes: `Cônjuge: ${conjuge.nome}${conjuge.aniversario ? ` (aniv: ${conjuge.aniversario})` : ''}`,
          updated_at:  new Date().toISOString()
        }, { onConflict: 'user_id' });

      // Salva como evento recorrente se tiver aniversário
      if (conjuge.aniversario) {
        await upsertEvent(userId, {
          title:           `Aniversário ${conjuge.nome}`,
          event_date:      normalizeDate(conjuge.aniversario),
          category:        'family',
          ...EVENT_WEIGHTS['aniversario_esposa']
        });
      }

      console.log('[Extrator/familia] Cônjuge:', conjuge.nome);
    }

    // ── Filhos → children ────────────────────────────────────
    const filhos: any[] = data.filhos || [];
    for (const filho of filhos) {
      if (!filho.nome) continue;

      const birthYear  = filho.idade ? new Date().getFullYear() - filho.idade : null;
      const birth_date = birthYear ? `${birthYear}-01-01` : null;
      const lifePhase  = getLifePhase(filho.idade);

      // Upsert por nome + parent para evitar duplicata
      const { data: existing } = await supabase
        .from('children')
        .select('id')
        .eq('parent_id', userId)
        .eq('name', filho.nome)
        .maybeSingle();

      if (existing?.id) {
        await supabase.from('children')
          .update({ birth_date, life_phase: lifePhase, updated_at: new Date().toISOString() })
          .eq('id', existing.id);
      } else {
        await supabase.from('children').insert({
          parent_id: userId, name: filho.nome,
          birth_date, life_phase: lifePhase,
          updated_at: new Date().toISOString()
        });
      }

      // Salva aniversário do filho como evento
      if (birth_date) {
        await upsertEvent(userId, {
          title:           `Aniversário ${filho.nome}`,
          event_date:      birth_date,
          category:        'family',
          ...EVENT_WEIGHTS['aniversario_filho'],
          notes:           `${lifePhase} — ${filho.idade} anos`
        });
      }

      console.log('[Extrator/familia] Filho:', filho.nome);
    }

  } catch (e) {
    console.error('[Extrator/familia] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: PROJETOS
// → projects
// ============================================================
async function extractProjeto(
  userId: string,
  userMessage: string,
  aiReply: string
): Promise<void> {
  const prompt = `
Extraia projetos, ideias ou iniciativas mencionadas.
Um projeto é qualquer coisa que a pessoa quer desenvolver, construir ou tirar do papel.
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "projetos": [
    {
      "nome": "Procuro Quem Faça",
      "tag": "pqf",
      "descricao": "plataforma de indicação de prestadores de serviço",
      "status": "beta",
      "contexto_tecnico": "Next.js, Supabase, homologação pendente"
    }
  ]
}

Regras:
- tag: slug curto em lowercase sem espaços (ex: "pqf", "lev-app", "site-pessoal")
- Retorne [] se nenhum projeto foi mencionado
- status: "ideia" | "em_desenvolvimento" | "beta" | "producao" | "pausado"
`;

  try {
    const raw = await callAI(prompt, 400);
    const data = JSON.parse(raw.replace(/```json|```/g, '').trim());

    for (const proj of (data.projetos || [])) {
      if (!proj.nome || !proj.tag) continue;

      // Upsert por tag — evita duplicatas
      await supabase
        .from('projects')
        .upsert({
          tag:               proj.tag,
          name:              proj.nome,
          description:       proj.descricao || null,
          context_technical: proj.contexto_tecnico
            ? `Status: ${proj.status || 'em_desenvolvimento'} | ${proj.contexto_tecnico}`
            : `Status: ${proj.status || 'em_desenvolvimento'}`,
        }, { onConflict: 'tag' });

      console.log('[Extrator/projeto] Upsert:', proj.nome);
    }
  } catch (e) {
    console.error('[Extrator/projeto] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: EVENTOS (datas comemorativas, recorrentes)
// → events
// ============================================================
async function extractEvento(
  userId: string,
  userName: string,
  userMessage: string,
  aiReply: string
): Promise<void> {
  const prompt = `
Extraia eventos, datas comemorativas ou aniversários mencionados.
NÃO inclua compromissos pontuais com hora (esses vão para agenda).
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "eventos": [
    {
      "titulo": "Festa Junina da Escola",
      "data": "2026-06-15",
      "tipo": "festa_escola",
      "recorrente": false,
      "notas": "escola do Miguel"
    }
  ]
}

Tipos possíveis:
- aniversario_esposa | aniversario_filho | aniversario_familiar | aniversario_amigo
- festa_escola | evento_escolar | consulta_medica | compromisso_trabalho
- entrega_projeto | default

Regras:
- data: formato YYYY-MM-DD (use ano atual se não informado)
- recorrente: true para aniversários anuais, false para eventos únicos
- Retorne [] se nenhum evento foi mencionado
`;

  try {
    const raw = await callAI(prompt, 400);
    const data = JSON.parse(raw.replace(/```json|```/g, '').trim());

    for (const ev of (data.eventos || [])) {
      if (!ev.titulo || !ev.data) continue;

      const weights = EVENT_WEIGHTS[ev.tipo] || EVENT_WEIGHTS['default'];

      await upsertEvent(userId, {
        title:            ev.titulo,
        event_date:       ev.data,
        category:         getCategoryFromType(ev.tipo),
        is_recurring:     ev.recorrente ?? weights.decay_type === 'recurring_annual',
        notes:            ev.notas || null,
        ...weights,
      });

      console.log('[Extrator/evento]', ev.titulo, ev.data);
    }
  } catch (e) {
    console.error('[Extrator/evento] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: AGENDA (compromissos pontuais com data/hora)
// → agenda
// ============================================================
async function extractAgenda(
  userId: string,
  userMessage: string,
  aiReply: string
): Promise<void> {
  const prompt = `
Extraia compromissos pontuais com data E hora específica mencionados.
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "compromissos": [
    {
      "descricao": "Consulta Dr. Adriano",
      "data_hora": "2026-03-05T10:20:00-03:00",
      "categoria": "Saúde"
    }
  ]
}

Categorias: Saúde | Trabalho | Escola | Família | Pessoal | Rotina
Regras:
- Só inclua se tiver data E hora explícitas
- data_hora: ISO 8601 com fuso -03:00 (Brasília)
- Retorne [] se nenhum compromisso pontual foi mencionado
`;

  try {
    const raw = await callAI(prompt, 300);
    const data = JSON.parse(raw.replace(/```json|```/g, '').trim());

    for (const comp of (data.compromissos || [])) {
      if (!comp.descricao || !comp.data_hora) continue;

      // Verifica duplicata por descrição + data
      const { data: existing } = await supabase
        .from('agenda')
        .select('id')
        .eq('owner_id', userId)
        .eq('description', comp.descricao)
        .eq('event_at', comp.data_hora)
        .maybeSingle();

      if (!existing) {
        await supabase.from('agenda').insert({
          owner_id:    userId,
          description: comp.descricao,
          event_at:    comp.data_hora,
          category:    comp.categoria || 'Pessoal',
        });
        console.log('[Extrator/agenda]', comp.descricao, comp.data_hora);
      }
    }
  } catch (e) {
    console.error('[Extrator/agenda] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: ROTINA
// → user_profiles.personality_notes (por ora)
// Atualiza L3 diretamente com informações de rotina
// ============================================================
async function extractRotina(
  userId: string,
  userMessage: string,
  aiReply: string
): Promise<void> {
  const prompt = `
Extraia informações de rotina mencionadas explicitamente.
Retorne APENAS JSON (null para não mencionados):

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "despertar": null,
  "dormir": null,
  "academia_horario": null,
  "trabalho_entrada": null,
  "trabalho_saida": null,
  "lembretes": []
}

Exemplos: "despertar": "05:00", "lembretes": ["roupa 18:30", "marmita 20:45"]
Retorne todos como null se nenhuma rotina foi mencionada.
`;

  try {
    const raw = await callAI(prompt, 300);
    const data = JSON.parse(raw.replace(/```json|```/g, '').trim());

    const hasData = Object.values(data).some(v => v !== null && (!Array.isArray(v) || v.length > 0));
    if (!hasData) return;

    // Rotina vai para personality_notes por enquanto
    // (pode virar tabela própria no futuro)
    const parts: string[] = [];
    if (data.despertar)         parts.push(`Despertar: ${data.despertar}`);
    if (data.dormir)            parts.push(`Dormir: ${data.dormir}`);
    if (data.academia_horario)  parts.push(`Academia: ${data.academia_horario}`);
    if (data.trabalho_entrada)  parts.push(`Trabalho entrada: ${data.trabalho_entrada}`);
    if (data.trabalho_saida)    parts.push(`Trabalho saída: ${data.trabalho_saida}`);
    if (data.lembretes?.length) parts.push(`Lembretes: ${data.lembretes.join(', ')}`);

    if (parts.length === 0) return;

    // Busca notes atual e atualiza
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('personality_notes')
      .eq('user_id', parseInt(userId))
      .maybeSingle();

    const existing = profile?.personality_notes || '';
    const rotinaTag = '[ROTINA]';
    const newBlock  = `${rotinaTag} ${parts.join(' | ')}`;

    const updated = existing.includes(rotinaTag)
      ? existing.replace(/\[ROTINA\].*/i, newBlock)
      : `${existing}\n${newBlock}`.trim();

    await supabase
      .from('user_profiles')
      .upsert({ user_id: parseInt(userId), personality_notes: updated, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });

    console.log('[Extrator/rotina] Atualizado:', parts.join(' | '));
  } catch (e) {
    console.error('[Extrator/rotina] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: PREFERÊNCIAS
// → user_profiles.personality_notes
// ============================================================
async function extractPreferencia(
  userId: string,
  userMessage: string,
  aiReply: string
): Promise<void> {
  const prompt = `
Extraia preferências pessoais mencionadas (gostos, lugares favoritos, opiniões).
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "preferencias": [
    { "tipo": "lugar", "descricao": "Feira do Produtor na Rua São Vicente aos sábados" },
    { "tipo": "comida", "descricao": "pastel perto do aeroporto de Londrina" }
  ]
}

Tipos: lugar | comida | filme | musica | esporte | hobby | outro
Retorne [] se nenhuma preferência foi mencionada.
`;

  try {
    const raw = await callAI(prompt, 300);
    const data = JSON.parse(raw.replace(/```json|```/g, '').trim());

    const prefs: any[] = data.preferencias || [];
    if (prefs.length === 0) return;

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('career_notes')
      .eq('user_id', parseInt(userId))
      .maybeSingle();

    // Usando career_notes como campo livre para preferências por ora
    // (schema não tem campo dedicado — pode adicionar depois)
    const existing = profile?.career_notes || '';
    const newPrefs = prefs.map(p => `[${p.tipo}] ${p.descricao}`).join(' | ');
    const updated  = existing ? `${existing} | ${newPrefs}` : newPrefs;

    await supabase
      .from('user_profiles')
      .upsert({ user_id: parseInt(userId), career_notes: updated, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });

    console.log('[Extrator/preferencia]', newPrefs);
  } catch (e) {
    console.error('[Extrator/preferencia] Erro:', e);
  }
}

// ============================================================
// ATUALIZA L3 A PARTIR DO ESTADO ATUAL DAS TABELAS
// Consolida tudo em current_context — chamado após todos extratores
// ============================================================
async function patchL3FromBrain(userId: string): Promise<void> {
  try {
    const uid = parseInt(userId);

    // Busca estado atual de todas as tabelas em paralelo
    const [profileResult, childrenResult, projectsResult, eventsResult, userResult] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', uid).maybeSingle(),
      supabase.from('children').select('name, birth_date, life_phase').eq('parent_id', userId),
      supabase.from('projects').select('name, description, context_technical').limit(10),
      supabase.from('events').select('title, event_date, priority, emotional_weight').eq('user_id', userId).order('event_date').limit(10),
      supabase.from('users').select('current_context').eq('id', uid).single(),
    ]);

    const p    = profileResult.data;
    const kids = childrenResult.data || [];
    const proj = projectsResult.data || [];
    const evs  = eventsResult.data || [];
    const base = userResult.data?.current_context || '';

    // Monta patches pontuais — preserva o L3 base, só atualiza seções conhecidas
    const patches: Record<string, string> = {};

    if (p?.city)        patches['Localização']  = `${p.city}${p.state ? `, ${p.state}` : ''}`;
    if (p?.birth_city)  patches['Origem']        = `${p.birth_city}${p.birth_state ? `, ${p.birth_state}` : ''}`;
    if (p?.current_job) patches['Emprego']       = `${p.current_job}${p.company ? ` @ ${p.company}` : ''}`;
    if (p?.birth_date)  patches['Nascimento']    = p.birth_date;
    if (p?.faith_profile && p.faith_profile !== 'unknown') patches['Fé'] = p.faith_profile;

    // Cônjuge extraído de personality_notes
    const conjugeMatch = p?.personality_notes?.match(/Cônjuge: ([^\n(]+)/);
    if (conjugeMatch) patches['Esposa/Marido'] = conjugeMatch[1].trim();

    // Filhos
    if (kids.length > 0) {
      patches['Filhos'] = kids.map(k => {
        const age = k.birth_date
          ? new Date().getFullYear() - new Date(k.birth_date).getFullYear()
          : null;
        return `${k.name}${age ? ` (${age} anos)` : ''}`;
      }).join(', ');
    }

    // Aplica patches no L3 existente
    let updated = base;
    for (const [key, val] of Object.entries(patches)) {
      const regex = new RegExp(`- ${key}:.*`, 'i');
      const line  = `- ${key}: ${val}`;
      updated = regex.test(updated)
        ? updated.replace(regex, line)
        : updated + `\n${line}`;
    }

    // Seção de projetos — atualiza bloco inteiro se houver
    if (proj.length > 0) {
      const projBlock = proj.map(r => `- ${r.name}: ${r.description || ''}`).join('\n');
      const projRegex = /## PROJETOS[\s\S]*?(?=\n##|$)/i;
      const newProjSection = `## PROJETOS\n${projBlock}`;
      updated = projRegex.test(updated)
        ? updated.replace(projRegex, newProjSection)
        : updated + `\n\n${newProjSection}`;
    }

    // Seção de eventos próximos relevantes
    const highEvs = evs.filter(e => (e.emotional_weight || 0) >= 0.7);
    if (highEvs.length > 0) {
      const evBlock = highEvs.map(e => `- ${e.title}: ${e.event_date}`).join('\n');
      const evRegex = /## DATAS IMPORTANTES[\s\S]*?(?=\n##|$)/i;
      const newEvSection = `## DATAS IMPORTANTES\n${evBlock}`;
      updated = evRegex.test(updated)
        ? updated.replace(evRegex, newEvSection)
        : updated + `\n\n${newEvSection}`;
    }

    await supabase
      .from('users')
      .update({ current_context: updated.trim() })
      .eq('id', uid);

    console.log('[Extrator/L3] Atualizado com patches:', Object.keys(patches).join(', '));
  } catch (e) {
    console.error('[Extrator/L3] Erro:', e);
  }
}

// ============================================================
// HELPERS
// ============================================================

async function callAI(prompt: string, maxTokens = 400): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "google/gemini-2.0-flash-001",
      max_tokens: maxTokens,
      temperature: 0.1, // baixo para extração precisa
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  return content.replace(/```json|```/g, '').trim();
}

async function upsertEvent(userId: string, ev: {
  title: string;
  event_date: string;
  category: string;
  priority: string;
  decay_type: string;
  emotional_weight: number;
  is_recurring?: boolean;
  notes?: string | null;
}): Promise<void> {
  // Verifica se já existe por título + user (evita duplicata)
  const { data: existing } = await supabase
    .from('events')
    .select('id')
    .eq('user_id', userId)
    .ilike('title', ev.title)
    .maybeSingle();

  if (existing?.id) {
    await supabase.from('events')
      .update({
        event_date:      ev.event_date,
        priority:        ev.priority,
        decay_type:      ev.decay_type,
        emotional_weight: ev.emotional_weight,
        notes:           ev.notes || null,
      })
      .eq('id', existing.id);
  } else {
    await supabase.from('events').insert({
      user_id:          userId,
      title:            ev.title,
      event_date:       ev.event_date,
      category:         ev.category,
      priority:         ev.priority,
      decay_type:       ev.decay_type,
      emotional_weight: ev.emotional_weight,
      is_recurring:     ev.is_recurring ?? (ev.decay_type === 'recurring_annual'),
      notes:            ev.notes || null,
      last_notified_year: new Date().getFullYear() - 1,
      relevance_score:  1.0,
    });
  }
}

function normalizeDate(raw: string): string {
  // Tenta normalizar "5 de agosto", "08-05", "05/08" para YYYY-MM-DD
  const months: Record<string, string> = {
    'janeiro': '01', 'fevereiro': '02', 'março': '03', 'abril': '04',
    'maio': '05', 'junho': '06', 'julho': '07', 'agosto': '08',
    'setembro': '09', 'outubro': '10', 'novembro': '11', 'dezembro': '12'
  };

  const year = new Date().getFullYear();

  // "5 de agosto" ou "5 agosto"
  const ptMatch = raw.match(/(\d{1,2})\s+de?\s+(\w+)/i);
  if (ptMatch) {
    const month = months[ptMatch[2].toLowerCase()];
    if (month) return `${year}-${month}-${ptMatch[1].padStart(2, '0')}`;
  }

  // "MM-DD" ou "DD/MM"
  const parts = raw.split(/[-\/]/);
  if (parts.length === 2) {
    return `${year}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  }

  return raw; // já está em formato correto
}

function getCategoryFromType(tipo: string): string {
  if (tipo.includes('escola') || tipo.includes('escolar')) return 'school';
  if (tipo.includes('medica') || tipo.includes('saude'))   return 'health';
  if (tipo.includes('trabalho') || tipo.includes('projeto')) return 'work';
  if (tipo.includes('aniversario') || tipo.includes('familiar')) return 'family';
  return 'personal';
}

function getLifePhase(age: number | null): string {
  if (!age)        return 'child';
  if (age <= 3)    return 'baby';
  if (age <= 11)   return 'child';
  if (age <= 17)   return 'teen';
  if (age <= 24)   return 'young_adult';
  return 'adult';
}
