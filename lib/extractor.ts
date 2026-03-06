// ============================================================
// lib/extractor.ts — Extrator Contínuo de Contexto
// Brain como Fonte da Verdade
//
// MAPEAMENTO COMPLETO DE TABELAS:
//
// user_profiles:
//   full_name, city, state, birth_city, birth_state, birth_date,
//   gender, current_job, company, whatsapp,
//   father_name, mother_name, siblings_count,
//   faith_profile, faith_notes,
//   education_level, schools,
//   spouse_name, spouse_birthday, spouse_phone, spouse_user_id,
//   career_notes, personality_notes
//
// children:
//   parent_id, name, nickname, birth_date, gender, life_phase,
//   school_name, school_grade, school_shift, child_user_id
//
// relationships (vínculos entre usuários do app):
//   user_id_a, user_id_b, relationship_type, status
//   Tipos: spouse | partner | parent | child | sibling | friend | colleague | other
//
// events:
//   user_id, title, event_date, category, priority,
//   decay_type, emotional_weight, is_recurring, notes
//
// agenda:
//   user_id, description, event_at, category
//
// projects:
//   user_id, tag, name, description, context_technical, status
//
// users:
//   pending_gaps (jsonb), assistant_name, timezone
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

// ── Tipos ────────────────────────────────────────────────────

export interface DetectedGap {
  field: string;
  context: string;
  hint: string;
  urgencia?: string;
}

interface Classification {
  has_new_facts: boolean;
  contexts: string[];
}

const EVENT_WEIGHTS: Record<string, { priority: string; decay_type: string; emotional_weight: number }> = {
  aniversario_esposa:   { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.95 },
  aniversario_filho:    { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.90 },
  aniversario_familiar: { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.80 },
  aniversario_amigo:    { priority: 'media', decay_type: 'recurring_annual', emotional_weight: 0.50 },
  festa_escola:         { priority: 'media', decay_type: 'one_time',         emotional_weight: 0.60 },
  evento_escolar:       { priority: 'media', decay_type: 'one_time',         emotional_weight: 0.55 },
  consulta_medica:      { priority: 'alta',  decay_type: 'deadline',         emotional_weight: 0.70 },
  compromisso_trabalho: { priority: 'media', decay_type: 'deadline',         emotional_weight: 0.40 },
  entrega_projeto:      { priority: 'alta',  decay_type: 'deadline',         emotional_weight: 0.60 },
  default:              { priority: 'media', decay_type: 'one_time',         emotional_weight: 0.50 },
};

// ============================================================
// ENTRADA PRINCIPAL
// ============================================================

export async function extractAndRoute(
  userId: string,
  userName: string,
  userMessage: string,
  aiReply: string
): Promise<void> {
  try {
    // Busca gaps pendentes para contextualizar o classificador
    const { data: userData } = await supabase
      .from('users')
      .select('pending_gaps')
      .eq('id', userId)
      .single();

    const pendingGaps: DetectedGap[] = userData?.pending_gaps || [];
    const gapsCtx = pendingGaps.length > 0
      ? `Gaps aguardando resposta: ${pendingGaps.map(g => `${g.field} (${g.context})`).join('; ')}`
      : '';

    // Estágio 1: Classificar
    const classification = await classify(userMessage, aiReply, gapsCtx);
    console.log('[Extrator] Classificação:', JSON.stringify(classification));

    if (!classification.has_new_facts) return;

    // Estágio 2: Detectar novos gaps
    const gaps = await detectGaps(userId, userMessage, aiReply, classification.contexts, pendingGaps);
    if (gaps.length > 0) {
      await supabase.from('users').update({ pending_gaps: gaps }).eq('id', userId);
      console.log('[Extrator] Gaps salvos:', gaps.map(g => g.field).join(', '));
    } else if (pendingGaps.length > 0) {
      await supabase.from('users').update({ pending_gaps: [] }).eq('id', userId);
    }

    // Estágio 3: Extratores em paralelo
    const tasks: Promise<void>[] = [];

    if (classification.contexts.includes('perfil'))      tasks.push(extractPerfil(userId, userMessage, aiReply));
    if (classification.contexts.includes('familia'))     tasks.push(extractFamilia(userId, userMessage, aiReply, pendingGaps));
    if (classification.contexts.includes('projeto'))     tasks.push(extractProjeto(userId, userMessage, aiReply));
    if (classification.contexts.includes('evento'))      tasks.push(extractEvento(userId, userMessage, aiReply));
    if (classification.contexts.includes('agenda'))      tasks.push(extractAgenda(userId, userMessage, aiReply));
    if (classification.contexts.includes('rotina'))      tasks.push(extractRotina(userId, userMessage, aiReply));
    if (classification.contexts.includes('preferencia')) tasks.push(extractPreferencia(userId, userMessage, aiReply));

    await Promise.allSettled(tasks);

    // Estágio 4: Atualiza L3
    await updateL3(userId);

  } catch (e) {
    console.error('[Extrator] Erro geral:', e);
  }
}

// ============================================================
// BLOCO DE GAPS PARA O PROMPT
// ============================================================

export async function buildGapsBlock(userId: string): Promise<string> {
  try {
    const { data } = await supabase
      .from('users')
      .select('pending_gaps')
      .eq('id', userId)
      .single();

    const gaps: DetectedGap[] = data?.pending_gaps || [];
    if (gaps.length === 0) return '';

    const lines = gaps
      .map(g => `- [${(g.urgencia || 'media').toUpperCase()}] ${g.context}\n  → ${g.hint}`)
      .join('\n');

    return [
      '[INFORMAÇÕES INCOMPLETAS — pergunte naturalmente quando houver abertura]',
      lines,
      'REGRA: Pergunte UMA lacuna por vez, de forma leve. Nunca interrompa o assunto principal.',
    ].join('\n');
  } catch {
    return '';
  }
}

// ============================================================
// CLASSIFICADOR
// Cobre TODOS os campos de user_profiles no contexto "perfil"
// ============================================================

async function classify(
  userMessage: string,
  aiReply: string,
  gapsCtx: string
): Promise<Classification> {
  const prompt = `Analise a troca e identifique contextos com FATOS NOVOS sobre o usuário.

Usuário: "${userMessage}"
Assistente: "${aiReply}"
${gapsCtx ? `\n${gapsCtx}` : ''}

Contextos e o que cada um cobre:
- "perfil": nome completo, cidade, estado, nascimento (data/cidade/estado), profissão, empresa,
            WhatsApp, nome do pai, nome da mãe, quantidade de irmãos, fé/religião,
            escolaridade, escola/faculdade que frequentou, gênero
- "familia": esposa/marido (nome, aniversário, telefone), filhos (nome, idade, gênero, escola)
- "projeto": projetos, ideias, apps, negócios que quer desenvolver
- "evento": aniversários, festas, datas comemorativas recorrentes (SEM hora específica)
- "agenda": compromissos com data E hora específica (consulta, reunião, voo)
- "rotina": horários fixos, hábitos diários, lembretes recorrentes
- "preferencia": gostos, lugares favoritos, comidas, hobbies, opiniões

REGRAS:
- has_new_facts: true se QUALQUER fato pessoal for mencionado
- Se gaps indicarem nome_esposa/nome_filho/nome_pai/nome_mae e usuário responder com nome → "familia" ou "perfil"
- Retorne has_new_facts: false APENAS para saudações, piadas, perguntas genéricas sem info pessoal

Retorne APENAS JSON:
{"has_new_facts": true, "contexts": ["perfil"]}`;

  try {
    const raw = await callAI(prompt, 150);
    return JSON.parse(raw);
  } catch {
    return { has_new_facts: false, contexts: [] };
  }
}

// ============================================================
// DETECTOR DE GAPS
// ============================================================

async function detectGaps(
  userId: string,
  userMessage: string,
  aiReply: string,
  contexts: string[],
  existingGaps: DetectedGap[]
): Promise<DetectedGap[]> {
  if (contexts.length === 0) return [];

  const [profileRes, childrenRes] = await Promise.all([
    supabase.from('user_profiles')
      .select('full_name, spouse_name, city, current_job, father_name, mother_name')
      .eq('user_id', userId).maybeSingle(),
    supabase.from('children').select('name').eq('parent_id', userId),
  ]);

  const p          = profileRes.data;
  const childNames = (childrenRes.data || []).map((c: any) => c.name);

  const prompt = `Identifique lacunas de informação na troca. Máximo 2 gaps.

Usuário: "${userMessage}"
Assistente: "${aiReply}"

Já sabemos:
- Nome completo: ${p?.full_name || 'desconhecido'}
- Cônjuge: ${p?.spouse_name || 'desconhecido'}
- Pai: ${p?.father_name || 'desconhecido'}
- Mãe: ${p?.mother_name || 'desconhecida'}
- Filhos: ${childNames.join(', ') || 'nenhum'}
- Cidade: ${p?.city || 'desconhecida'}
- Profissão: ${p?.current_job || 'desconhecida'}

Contextos detectados: ${contexts.join(', ')}

Retorne APENAS JSON:
{
  "gaps": [
    {
      "field": "nome_esposa",
      "context": "usuário mencionou cônjuge mas nome é desconhecido",
      "hint": "Que legal! E como ela se chama?",
      "urgencia": "alta"
    }
  ]
}

Campos válidos: nome_esposa, nome_marido, nome_filho, nome_pai, nome_mae,
                tema_evento, data_evento, nome_medico, nome_projeto
urgencia: "alta" | "media" | "baixa"
Retorne {"gaps": []} se não há lacunas relevantes.`;

  try {
    const raw  = await callAI(prompt, 250);
    const data = JSON.parse(raw);
    return (data.gaps || []).filter((g: DetectedGap) => g.urgencia !== 'baixa');
  } catch {
    return [];
  }
}

// ============================================================
// EXTRATOR: PERFIL COMPLETO
// Cobre todos os campos de user_profiles
// ============================================================

async function extractPerfil(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia dados de perfil pessoal mencionados explicitamente.
Retorne APENAS JSON com os campos encontrados (null para não mencionados):

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "nome_completo": null,
  "cidade": null,
  "estado": null,
  "cidade_natal": null,
  "estado_natal": null,
  "nascimento": null,
  "profissao": null,
  "empresa": null,
  "genero": null,
  "whatsapp": null,
  "nome_pai": null,
  "nome_mae": null,
  "qtd_irmaos": null,
  "fe": null,
  "fe_notas": null,
  "escolaridade": null,
  "escola": null
}

REGRAS OBRIGATÓRIAS:
- nome_completo: extraia se o usuário mencionar seu próprio nome completo ou parte dele
- cidade/estado: se cidade conhecida, infira estado (Londrina→PR, São Paulo→SP, Curitiba→PR, etc). Estado = sigla 2 letras
- cidade_natal/estado_natal: cidade/estado onde nasceu (diferente de onde mora)
- nascimento: formato YYYY-MM-DD
- fe: APENAS "christian_declared" | "open" | "none" (null se não mencionado)
- escolaridade: APENAS "fundamental"|"medio"|"tecnico"|"superior_cursando"|"superior_completo"|"pos_graduacao"|"mestrado"|"doutorado"
- qtd_irmaos: número inteiro (0 se disse que não tem irmãos)
- Retorne null para campos não mencionados — nunca invente`;

  try {
    const data = JSON.parse(await callAI(prompt, 350));
    const patch: Record<string, any> = {};

    if (data.nome_completo) patch.full_name    = data.nome_completo;
    if (data.cidade)        patch.city         = data.cidade;
    if (data.estado)        patch.state        = data.estado;
    if (data.cidade_natal)  patch.birth_city   = data.cidade_natal;
    if (data.estado_natal)  patch.birth_state  = data.estado_natal;
    if (data.nascimento)    patch.birth_date   = data.nascimento;
    if (data.profissao)     patch.current_job  = data.profissao;
    if (data.empresa)       patch.company      = data.empresa;
    if (data.whatsapp)      patch.whatsapp     = data.whatsapp;
    if (data.nome_pai)      patch.father_name  = data.nome_pai;
    if (data.nome_mae)      patch.mother_name  = data.nome_mae;
    if (data.fe)            patch.faith_profile = data.fe;
    if (data.fe_notas)      patch.faith_notes  = data.fe_notas;

    if (data.qtd_irmaos !== null && data.qtd_irmaos !== undefined) {
      patch.siblings_count = parseInt(String(data.qtd_irmaos));
    }

    if (data.escolaridade) {
      const validos = ['fundamental','medio','tecnico','superior_cursando',
                       'superior_completo','pos_graduacao','mestrado','doutorado'];
      if (validos.includes(data.escolaridade)) patch.education_level = data.escolaridade;
    }

    if (data.escola) {
      const { data: prof } = await supabase
        .from('user_profiles').select('schools').eq('user_id', userId).maybeSingle();
      const existing: string[] = prof?.schools || [];
      if (!existing.includes(data.escola)) {
        patch.schools = [...existing, data.escola];
      }
    }

    if (data.genero) {
      const g = data.genero.toLowerCase();
      patch.gender = g.includes('masc') || g === 'm' ? 'masculino'
                   : g.includes('fem')  || g === 'f' ? 'feminino'
                   : 'prefiro_nao_dizer';
    }

    if (Object.keys(patch).length === 0) return;
    patch.user_id    = userId;
    patch.updated_at = new Date().toISOString();

    const { error } = await supabase.from('user_profiles').upsert(patch, { onConflict: 'user_id' });
    if (error) console.error('[Extrator/perfil] Erro upsert:', error);
    else console.log('[Extrator/perfil] Gravou:', Object.keys(patch).filter(k => k !== 'user_id' && k !== 'updated_at').join(', '));
  } catch (e) {
    console.error('[Extrator/perfil] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: FAMÍLIA
// → user_profiles (cônjuge), children, events
// ============================================================

async function extractFamilia(
  userId: string,
  userMessage: string,
  aiReply: string,
  gaps: DetectedGap[]
): Promise<void> {
  const hasEsposaGap = gaps.some(g => g.field === 'nome_esposa' || g.field === 'nome_marido');
  const hasFilhoGap  = gaps.some(g => g.field === 'nome_filho');

  const prompt = `Extraia dados familiares mencionados explicitamente.
${hasEsposaGap ? 'PRIORIDADE: usuário está fornecendo nome do cônjuge — extraia.' : ''}
${hasFilhoGap  ? 'PRIORIDADE: usuário está fornecendo nome de filho — extraia.' : ''}

Retorne APENAS JSON (null para não mencionados):

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "esposa": {"nome": null, "aniversario": null, "telefone": null},
  "marido": {"nome": null, "aniversario": null, "telefone": null},
  "filhos": [
    {"nome": null, "idade": null, "genero": null, "escola": null, "serie": null}
  ]
}

REGRAS:
- filhos: retorne [] se nenhum filho mencionado
- aniversario: formato YYYY-MM-DD ou DD/MM ou "5 de agosto"
- genero: "m" | "f" | null`;

  try {
    const data = JSON.parse(await callAI(prompt, 350));

    // ── Cônjuge ──────────────────────────────────────────────
    const conjuge = data.esposa?.nome ? data.esposa : data.marido?.nome ? data.marido : null;
    if (conjuge?.nome) {
      const patch: Record<string, any> = {
        user_id:     userId,
        spouse_name: conjuge.nome,
        updated_at:  new Date().toISOString(),
      };
      if (conjuge.aniversario) patch.spouse_birthday = normalizeDate(conjuge.aniversario);
      if (conjuge.telefone)    patch.spouse_phone    = conjuge.telefone;

      const { error } = await supabase.from('user_profiles').upsert(patch, { onConflict: 'user_id' });
      if (error) console.error('[Extrator/familia] Erro cônjuge:', error);
      else console.log('[Extrator/familia] Cônjuge:', conjuge.nome);

      if (conjuge.aniversario) {
        await upsertEvent(userId, {
          title:      `Aniversário ${conjuge.nome}`,
          event_date: normalizeDate(conjuge.aniversario),
          category:   'family',
          ...EVENT_WEIGHTS.aniversario_esposa,
        });
      }
    }

    // ── Filhos ───────────────────────────────────────────────
    for (const filho of (data.filhos || [])) {
      if (!filho.nome) continue;

      const birthYear  = filho.idade ? new Date().getFullYear() - filho.idade : null;
      const birth_date = birthYear ? `${birthYear}-01-01` : null;
      const life_phase = getLifePhase(filho.idade);

      const { data: ex } = await supabase
        .from('children').select('id')
        .eq('parent_id', userId).eq('name', filho.nome).maybeSingle();

      const childData: Record<string, any> = {
        birth_date,life_phase,
        updated_at: new Date().toISOString(),
      };
      if (filho.genero)  childData.gender       = filho.genero === 'm' ? 'm' : 'f';
      if (filho.escola)  childData.school_name  = filho.escola;
      if (filho.serie)   childData.school_grade = filho.serie;

      if (ex?.id) {
        await supabase.from('children').update(childData).eq('id', ex.id);
      } else {
        await supabase.from('children').insert({
          parent_id: userId,
          name: filho.nome,
          ...childData,
        });
      }

      if (birth_date) {
        await upsertEvent(userId, {
          title:      `Aniversário ${filho.nome}`,
          event_date: birth_date,
          category:   'family',
          notes:      `${life_phase} — ${filho.idade} anos`,
          ...EVENT_WEIGHTS.aniversario_filho,
        });
      }
      console.log('[Extrator/familia] Filho:', filho.nome);
    }
  } catch (e) {
    console.error('[Extrator/familia] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: PROJETOS → projects
// ============================================================

async function extractProjeto(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia projetos ou ideias mencionados.
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "projetos": [
    {
      "nome": null,
      "tag": null,
      "descricao": null,
      "status": null,
      "contexto_tecnico": null
    }
  ]
}

REGRAS:
- tag: slug lowercase sem espaços (ex: "pqf", "lev-app")
- status: "ideia"|"em_desenvolvimento"|"beta"|"producao"|"pausado"
- Retorne projetos: [] se nenhum mencionado`;

  try {
    const data = JSON.parse(await callAI(prompt, 300));
    for (const proj of (data.projetos || [])) {
      if (!proj.nome || !proj.tag) continue;
      const { error } = await supabase.from('projects').upsert({
        user_id:           userId,
        tag:               proj.tag,
        name:              proj.nome,
        description:       proj.descricao || null,
        context_technical: proj.contexto_tecnico || null,
        status:            proj.status || 'em_desenvolvimento',
        updated_at:        new Date().toISOString(),
      }, { onConflict: 'tag' });
      if (error) console.error('[Extrator/projeto] Erro:', error);
      else console.log('[Extrator/projeto]', proj.nome);
    }
  } catch (e) {
    console.error('[Extrator/projeto] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: EVENTOS → events
// ============================================================

async function extractEvento(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia eventos ou datas comemorativas mencionados (SEM hora específica).
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "eventos": [
    {
      "titulo": null,
      "data": null,
      "tipo": null,
      "recorrente": false,
      "notas": null
    }
  ]
}

Tipos: aniversario_esposa|aniversario_filho|aniversario_familiar|aniversario_amigo|
       festa_escola|evento_escolar|consulta_medica|compromisso_trabalho|entrega_projeto|default
data: YYYY-MM-DD (ano atual se não informado)
Retorne eventos: [] se nenhum mencionado`;

  try {
    const data = JSON.parse(await callAI(prompt, 300));
    for (const ev of (data.eventos || [])) {
      if (!ev.titulo || !ev.data) continue;
      const w = EVENT_WEIGHTS[ev.tipo] || EVENT_WEIGHTS.default;
      await upsertEvent(userId, {
        title:        ev.titulo,
        event_date:   ev.data,
        category:     getCategoryFromType(ev.tipo),
        is_recurring: ev.recorrente ?? w.decay_type === 'recurring_annual',
        notes:        ev.notas || null,
        ...w,
      });
      console.log('[Extrator/evento]', ev.titulo);
    }
  } catch (e) {
    console.error('[Extrator/evento] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: AGENDA → agenda
// ============================================================

async function extractAgenda(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia compromissos com data E hora explícitas.
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "compromissos": [
    {
      "descricao": null,
      "data_hora": null,
      "categoria": null
    }
  ]
}

data_hora: ISO 8601 fuso -03:00 (ex: "2026-03-10T10:00:00-03:00")
Categorias: Saúde|Trabalho|Escola|Família|Pessoal|Rotina
Retorne compromissos: [] se nenhum mencionado`;

  try {
    const data = JSON.parse(await callAI(prompt, 250));
    for (const comp of (data.compromissos || [])) {
      if (!comp.descricao || !comp.data_hora) continue;
      const { data: ex } = await supabase.from('agenda').select('id')
        .eq('user_id', userId).eq('description', comp.descricao).eq('event_at', comp.data_hora).maybeSingle();
      if (!ex) {
        const { error } = await supabase.from('agenda').insert({
          user_id:     userId,
          description: comp.descricao,
          event_at:    comp.data_hora,
          category:    comp.categoria || 'Pessoal',
        });
        if (error) console.error('[Extrator/agenda] Erro:', error);
        else console.log('[Extrator/agenda]', comp.descricao);
      }
    }
  } catch (e) {
    console.error('[Extrator/agenda] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: ROTINA → user_profiles.personality_notes
// ============================================================

async function extractRotina(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia informações de rotina mencionadas explicitamente.
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
}`;

  try {
    const data  = JSON.parse(await callAI(prompt, 200));
    const parts: string[] = [];
    if (data.despertar)         parts.push(`Despertar: ${data.despertar}`);
    if (data.dormir)            parts.push(`Dormir: ${data.dormir}`);
    if (data.academia_horario)  parts.push(`Academia: ${data.academia_horario}`);
    if (data.trabalho_entrada)  parts.push(`Trabalho entrada: ${data.trabalho_entrada}`);
    if (data.trabalho_saida)    parts.push(`Trabalho saída: ${data.trabalho_saida}`);
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
  } catch (e) {
    console.error('[Extrator/rotina] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: PREFERÊNCIAS → user_profiles.career_notes
// ============================================================

async function extractPreferencia(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia preferências pessoais mencionadas (gostos, lugares, hobbies).
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "preferencias": [
    {"tipo": "lugar", "descricao": "Feira do Produtor aos sábados"}
  ]
}

Tipos: lugar|comida|filme|musica|esporte|hobby|outro
Retorne preferencias: [] se nenhuma mencionada`;

  try {
    const data  = JSON.parse(await callAI(prompt, 200));
    const prefs: any[] = data.preferencias || [];
    if (prefs.length === 0) return;

    const { data: prof } = await supabase.from('user_profiles')
      .select('career_notes').eq('user_id', userId).maybeSingle();
    const old     = prof?.career_notes || '';
    const newLine = prefs.map((p: any) => `[${p.tipo}] ${p.descricao}`).join(' | ');
    const updated = old ? `${old} | ${newLine}` : newLine;

    await supabase.from('user_profiles').upsert(
      { user_id: userId, career_notes: updated, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
    console.log('[Extrator/preferencia]', newLine);
  } catch (e) {
    console.error('[Extrator/preferencia] Erro:', e);
  }
}

// ============================================================
// ATUALIZA L3 (users.current_context)
// ============================================================

async function updateL3(userId: string): Promise<void> {
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

    if (p?.full_name)   patches['Nome']        = p.full_name;
    if (p?.city)        patches['Localização'] = `${p.city}${p.state ? `, ${p.state}` : ''}`;
    if (p?.birth_city)  patches['Origem']      = `${p.birth_city}${p.birth_state ? `, ${p.birth_state}` : ''}`;
    if (p?.birth_date)  patches['Nascimento']  = p.birth_date;
    if (p?.current_job) patches['Emprego']     = `${p.current_job}${p.company ? ` @ ${p.company}` : ''}`;
    if (p?.faith_profile && p.faith_profile !== 'unknown') patches['Fé'] = p.faith_profile;
    if (p?.spouse_name) patches['Cônjuge']     = `${p.spouse_name}${p.spouse_birthday ? ` (aniv: ${p.spouse_birthday})` : ''}`;
    if (p?.father_name) patches['Pai']         = p.father_name;
    if (p?.mother_name) patches['Mãe']         = p.mother_name;
    if (p?.education_level) patches['Educação'] = p.education_level;

    if (kids.length > 0) {
      patches['Filhos'] = kids.map((k: any) => {
        const age = k.birth_date
          ? new Date().getFullYear() - new Date(k.birth_date).getFullYear()
          : null;
        return `${k.name}${age ? ` (${age} anos)` : ''}`;
      }).join(', ');
    }

    // Aplica patches
    for (const [key, val] of Object.entries(patches)) {
      const rx   = new RegExp(`- ${key}:.*`, 'i');
      const line = `- ${key}: ${val}`;
      ctx = rx.test(ctx) ? ctx.replace(rx, line) : `${ctx}\n${line}`;
    }

    // Seção projetos
    if (proj.length > 0) {
      const block   = proj.map((r: any) => `- ${r.name}${r.status ? ` [${r.status}]` : ''}: ${r.description || ''}`).join('\n');
      const section = `## PROJETOS\n${block}`;
      ctx = /## PROJETOS[\s\S]*?(?=\n##|$)/i.test(ctx)
        ? ctx.replace(/## PROJETOS[\s\S]*?(?=\n##|$)/i, section)
        : `${ctx}\n\n${section}`;
    }

    // Seção datas importantes
    const highEvs = evs.filter((e: any) => (e.emotional_weight || 0) >= 0.7);
    if (highEvs.length > 0) {
      const block   = highEvs.map((e: any) => `- ${e.title}: ${e.event_date}`).join('\n');
      const section = `## DATAS IMPORTANTES\n${block}`;
      ctx = /## DATAS IMPORTANTES[\s\S]*?(?=\n##|$)/i.test(ctx)
        ? ctx.replace(/## DATAS IMPORTANTES[\s\S]*?(?=\n##|$)/i, section)
        : `${ctx}\n\n${section}`;
    }

    const { error } = await supabase.from('users')
      .update({ current_context: ctx.trim() }).eq('id', userId);
    if (error) console.error('[Extrator/L3] Erro:', error);
    else console.log('[Extrator/L3] Patches:', Object.keys(patches).join(', '));
  } catch (e) {
    console.error('[Extrator/L3] Erro:', e);
  }
}

// ============================================================
// HELPERS
// ============================================================

async function callAI(prompt: string, maxTokens = 300): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.0-flash-001',
      max_tokens: maxTokens,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '')
    .replace(/```json|```/g, '')
    .trim();
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
  const { data: ex } = await supabase.from('events').select('id')
    .eq('user_id', userId).ilike('title', ev.title).maybeSingle();

  if (ex?.id) {
    await supabase.from('events').update({
      event_date:       ev.event_date,
      priority:         ev.priority,
      decay_type:       ev.decay_type,
      emotional_weight: ev.emotional_weight,
      notes:            ev.notes || null,
    }).eq('id', ex.id);
  } else {
    await supabase.from('events').insert({
      user_id:            userId,
      title:              ev.title,
      event_date:         ev.event_date,
      category:           ev.category,
      priority:           ev.priority,
      decay_type:         ev.decay_type,
      emotional_weight:   ev.emotional_weight,
      is_recurring:       ev.is_recurring ?? ev.decay_type === 'recurring_annual',
      notes:              ev.notes || null,
      last_notified_year: new Date().getFullYear() - 1,
      relevance_score:    1.0,
    });
  }
}

function normalizeDate(raw: string): string {
  if (!raw) return raw;
  const months: Record<string, string> = {
    janeiro: '01', fevereiro: '02', marco: '03', abril: '04',
    maio: '05', junho: '06', julho: '07', agosto: '08',
    setembro: '09', outubro: '10', novembro: '11', dezembro: '12',
  };
  const year    = new Date().getFullYear();
  const ptMatch = raw.match(/(\d{1,2})\s+de?\s+(\w+)/i);
  if (ptMatch) {
    const mon = months[ptMatch[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')];
    if (mon) return `${year}-${mon}-${ptMatch[1].padStart(2, '0')}`;
  }
  const parts = raw.split(/[-/]/);
  if (parts.length === 2) {
    return `${year}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  }
  if (parts.length === 3) return raw; // já YYYY-MM-DD
  return raw;
}

function getCategoryFromType(tipo: string): string {
  if (/escola|escolar/.test(tipo))       return 'school';
  if (/medic|saude/.test(tipo))          return 'health';
  if (/trabalho|projeto/.test(tipo))     return 'work';
  if (/aniversario|familiar/.test(tipo)) return 'family';
  return 'personal';
}

function getLifePhase(age: number | null): string {
  if (!age || age <= 0) return 'child';
  if (age <= 3)         return 'baby';
  if (age <= 11)        return 'child';
  if (age <= 17)        return 'teen';
  if (age <= 24)        return 'young_adult';
  return 'adult';
}