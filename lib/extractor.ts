// ============================================================
// lib/extractor.ts — Extrator Contínuo de Contexto
// ============================================================
//
// MAPEAMENTO DE TABELAS:
//
// user_profiles:
//   full_name, preferred_name, nickname, phone, whatsapp
//   city, state, birth_city, birth_state, birth_date, gender
//   profession (formação/área), current_job (cargo), company, job_start_date
//   father_name, mother_name, siblings_count
//   faith_profile, faith_notes, education_level, schools
//   spouse_name, spouse_birthday, spouse_phone, spouse_user_id
//   career_notes, personality_notes
//
// children:
//   parent_id, name, nickname, birth_date, gender, life_phase
//   school_name, school_grade, school_shift, child_user_id
//
// contact_aliases:
//   user_id, alias, refers_to_type, refers_to_id, refers_to_name
//
// events, agenda, projects, users.pending_gaps
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

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
    const { data: userData } = await supabase
      .from('users').select('pending_gaps').eq('id', userId).single();

    const pendingGaps: DetectedGap[] = userData?.pending_gaps || [];
    const gapsCtx = pendingGaps.length > 0
      ? `Gaps aguardando resposta: ${pendingGaps.map(g => `${g.field} (${g.context})`).join('; ')}`
      : '';

    const classification = await classify(userMessage, aiReply, gapsCtx);
    console.log('[Extrator] Classificação:', JSON.stringify(classification));

    if (!classification.has_new_facts) return;

    // Detecta gaps novos
    const gaps = await detectGaps(userId, userMessage, aiReply, classification.contexts, pendingGaps);
    if (gaps.length > 0) {
      await supabase.from('users').update({ pending_gaps: gaps }).eq('id', userId);
      console.log('[Extrator] Gaps:', gaps.map(g => g.field).join(', '));
    } else if (pendingGaps.length > 0) {
      await supabase.from('users').update({ pending_gaps: [] }).eq('id', userId);
    }

    // Extratores em paralelo
    const tasks: Promise<void>[] = [];
    if (classification.contexts.includes('perfil'))      tasks.push(extractPerfil(userId, userMessage, aiReply));
    if (classification.contexts.includes('familia'))     tasks.push(extractFamilia(userId, userMessage, aiReply, pendingGaps));
    if (classification.contexts.includes('alias'))       tasks.push(extractAlias(userId, userMessage, aiReply));
    if (classification.contexts.includes('projeto'))     tasks.push(extractProjeto(userId, userMessage, aiReply));
    if (classification.contexts.includes('evento'))      tasks.push(extractEvento(userId, userMessage, aiReply));
    if (classification.contexts.includes('agenda'))      tasks.push(extractAgenda(userId, userMessage, aiReply));
    if (classification.contexts.includes('rotina'))      tasks.push(extractRotina(userId, userMessage, aiReply));
    if (classification.contexts.includes('preferencia')) tasks.push(extractPreferencia(userId, userMessage, aiReply));

    await Promise.allSettled(tasks);
    await updateL3(userId);
  } catch (e) {
    console.error('[Extrator] Erro geral:', e);
  }
}

// ============================================================
// EXTRAÇÃO COM RESUMO — para feedback na resposta do Jarvis
// Roda antes da resposta e retorna o que foi gravado
// ============================================================

export async function extractAndSummarize(
  userId: string,
  userName: string,
  userMessage: string
): Promise<string> {
  // Usamos string vazia como aiReply pois ainda não foi gerado
  // O classificador trabalha só com userMessage nesse modo
  try {
    const { data: userData } = await supabase
      .from('users').select('pending_gaps').eq('id', userId).single();

    const pendingGaps: DetectedGap[] = userData?.pending_gaps || [];
    const gapsCtx = pendingGaps.length > 0
      ? `Gaps aguardando resposta: ${pendingGaps.map(g => `${g.field} (${g.context})`).join('; ')}`
      : '';

    const classification = await classify(userMessage, '', gapsCtx);
    if (!classification.has_new_facts) return '';

    // Gaps
    const gaps = await detectGaps(userId, userMessage, '', classification.contexts, pendingGaps);
    if (gaps.length > 0) {
      await supabase.from('users').update({ pending_gaps: gaps }).eq('id', userId);
    } else if (pendingGaps.length > 0) {
      await supabase.from('users').update({ pending_gaps: [] }).eq('id', userId);
    }

    // Extratores em paralelo
    const tasks: Promise<void>[] = [];
    if (classification.contexts.includes('perfil'))      tasks.push(extractPerfil(userId, userMessage, ''));
    if (classification.contexts.includes('familia'))     tasks.push(extractFamilia(userId, userMessage, '', pendingGaps));
    if (classification.contexts.includes('alias'))       tasks.push(extractAlias(userId, userMessage, ''));
    if (classification.contexts.includes('projeto'))     tasks.push(extractProjeto(userId, userMessage, ''));
    if (classification.contexts.includes('evento'))      tasks.push(extractEvento(userId, userMessage, ''));
    if (classification.contexts.includes('agenda'))      tasks.push(extractAgenda(userId, userMessage, ''));
    if (classification.contexts.includes('rotina'))      tasks.push(extractRotina(userId, userMessage, ''));
    if (classification.contexts.includes('preferencia')) tasks.push(extractPreferencia(userId, userMessage, ''));

    await Promise.allSettled(tasks);
    await updateL3(userId);

    // Gera resumo humano do que foi gravado
    return summarizeContexts(classification.contexts);
  } catch (e) {
    console.error('[Extrator/summarize] Erro:', e);
    return '';
  }
}

function summarizeContexts(contexts: string[]): string {
  const labels: Record<string, string> = {
    perfil:      'dados do seu perfil',
    familia:     'informações da sua família',
    alias:       'apelido registrado',
    projeto:     'projeto/ideia anotado',
    evento:      'data importante salva',
    agenda:      'compromisso na agenda',
    rotina:      'rotina atualizada',
    preferencia: 'preferência registrada',
  };
  const found = contexts.filter(c => labels[c]).map(c => labels[c]);
  if (found.length === 0) return '';
  if (found.length === 1) return found[0];
  return found.slice(0, -1).join(', ') + ' e ' + found[found.length - 1];
}

export async function buildGapsBlock(userId: string): Promise<string> {
  try {
    const { data } = await supabase
      .from('users').select('pending_gaps').eq('id', userId).single();

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

Contextos disponíveis:
- "perfil": nome completo, nome preferido, apelido pessoal, cidade/estado atual,
            cidade/estado natal, data de nascimento, gênero,
            telefone, whatsapp, número de irmãos,
            FORMAÇÃO/ÁREA (engenharia, medicina, direito) → campo profession,
            CARGO/EMPREGO (técnico, analista, gerente) → campo current_job,
            EMPRESA onde trabalha ou VAI trabalhar → campo company,
            DATA DE INÍCIO de emprego → campo job_start_date,
            nome do pai, nome da mãe, fé/religião, escola/faculdade cursada
- "familia": esposa/marido (nome, aniversário, telefone), filhos (nome, idade, escola)
- "alias": apelido que o usuário usa para chamar alguém ("vida"=esposa, "velho"=pai)
- "projeto": projetos, ideias, apps, negócios
- "evento": aniversários, festas, datas recorrentes (sem hora)
- "agenda": compromissos com data E hora específica
- "rotina": horários fixos, hábitos diários
- "preferencia": gostos, lugares favoritos, hobbies

REGRAS CRÍTICAS:
- Formação acadêmica (curso, faculdade) → "perfil" NUNCA "emprego"
- Emprego futuro ("vou começar", "a partir de", "fui contratado") → "perfil" com job_start_date
- Telefone/WhatsApp/celular → sempre "perfil"
- Se gaps indicarem campo pendente e usuário responder → inclua o contexto correto
- has_new_facts: false APENAS para saudações e piadas sem info pessoal

Retorne APENAS JSON:
{"has_new_facts": true, "contexts": ["perfil"]}`;

  try {
    const raw = await callAI(prompt, 200);
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
      .select('full_name, spouse_name, city, current_job, father_name, mother_name, profession')
      .eq('user_id', userId).maybeSingle(),
    supabase.from('children').select('name').eq('parent_id', userId),
  ]);

  const p          = profileRes.data;
  const childNames = (childrenRes.data || []).map((c: any) => c.name);

  const prompt = `Identifique lacunas de informação na troca. Máximo 2 gaps relevantes.

Usuário: "${userMessage}"
Assistente: "${aiReply}"

Já sabemos:
- Nome: ${p?.full_name || 'desconhecido'}
- Cônjuge: ${p?.spouse_name || 'desconhecido'}
- Pai: ${p?.father_name || 'desconhecido'}
- Mãe: ${p?.mother_name || 'desconhecida'}
- Filhos: ${childNames.join(', ') || 'nenhum'}
- Cidade: ${p?.city || 'desconhecida'}
- Profissão/área: ${p?.profession || 'desconhecida'}
- Cargo atual: ${p?.current_job || 'desconhecido'}

Contextos detectados: ${contexts.join(', ')}

Campos válidos para gaps:
- nome_completo: mencionou primeiro nome mas sobrenome desconhecido
- nome_esposa / nome_marido: cônjuge mencionado sem nome
- nome_filho: filho mencionado sem nome
- nome_pai / nome_mae: pai/mãe mencionados sem nome
- data_nascimento_filho: filho mencionado sem idade/data
- tema_evento: evento sem detalhes suficientes
- data_evento: evento sem data
- nome_medico: consulta sem nome do médico
- nome_projeto: projeto/ideia sem nome

Retorne APENAS JSON:
{
  "gaps": [
    {
      "field": "nome_esposa",
      "context": "cônjuge mencionado mas nome desconhecido",
      "hint": "Que legal! E como ela se chama?",
      "urgencia": "alta"
    }
  ]
}

urgencia: "alta"=bloqueia ação | "media"=enriquece | "baixa"=opcional
Retorne {"gaps": []} se não há lacunas relevantes.`;

  try {
    const raw  = await callAI(prompt, 300);
    const data = JSON.parse(raw);
    return (data.gaps || []).filter((g: DetectedGap) => g.urgencia !== 'baixa');
  } catch {
    return [];
  }
}

// ============================================================
// EXTRATOR: PERFIL COMPLETO
// Separa formação (profession) de cargo (current_job)
// Captura telefone/whatsapp independente da palavra usada
// ============================================================

async function extractPerfil(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia dados de perfil pessoal mencionados explicitamente.
Retorne APENAS JSON (null para campos não mencionados):

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "nome_completo": null,
  "nome_preferido": null,
  "apelido": null,
  "cidade": null,
  "estado": null,
  "cidade_natal": null,
  "estado_natal": null,
  "nascimento": null,
  "genero": null,
  "telefone": null,
  "whatsapp": null,
  "nome_pai": null,
  "nome_mae": null,
  "qtd_irmaos": null,
  "fe": null,
  "fe_notas": null,
  "formacao": null,
  "cargo_atual": null,
  "empresa": null,
  "data_inicio_emprego": null,
  "escolaridade": null,
  "escola": null
}

REGRAS CRÍTICAS:
- nome_completo: nome inteiro com sobrenome(s). "Celio Roberto Ramos do Nascimento" → extrai tudo
  ATENÇÃO: "pode me chamar de Celio" ou "me chama de X" → NÃO é nome_completo, é nome_preferido
  nome_completo só se tiver sobrenome(s) junto
- nome_preferido: como prefere ser chamado. "pode me chamar de Celio" → nome_preferido="Celio"
  "prefiro Jessica" → "Jessica" | "me chama de Cel" → "Cel"
- genero: extraia EXPLICITAMENTE ("sou do sexo masculino", "sou homem/mulher")
  TAMBÉM infira por contexto: "minha esposa" → genero="masculino" | "meu marido" → genero="feminino"
- cidade/estado: infira estado pela cidade (Londrina→PR, São Paulo→SP). Estado = sigla 2 letras
- cidade_natal vs cidade: natal=onde nasceu, cidade=onde mora. SÃO CAMPOS DIFERENTES
- telefone: qualquer número de contato ("telefone", "celular", "número", "fone", "contato")
- whatsapp: número mencionado como "whatsapp", "wpp" ou "zap"
- formacao: ÁREA DE ESTUDO ("Engenharia de Computação", "Medicina"). NÃO é cargo, NÃO é empresa
- cargo_atual: FUNÇÃO/CARGO ("Técnico Jr de Manutenção", "Analista"). NÃO é área de estudo
- empresa: empresa onde trabalha ou VAI trabalhar. NÃO é escola/faculdade
- data_inicio_emprego: "a partir do dia 12/03/2026" → "2026-03-12". Formato YYYY-MM-DD
- escolaridade: APENAS "fundamental"|"medio"|"tecnico"|"superior_cursando"|"superior_completo"|"pos_graduacao"|"mestrado"|"doutorado"
- escola: nome da instituição de ensino. NÃO é empresa
- fe: APENAS "christian_declared"|"open"|"none"
- qtd_irmaos: número inteiro

EXEMPLOS:
- "fiz Eng. Computação na Unopar" → formacao="Engenharia de Computação", escola="Unopar", empresa=null
- "vou trabalhar na White Martins como Técnico Jr a partir de 12/03" → cargo_atual="Técnico Jr de Manutenção", empresa="White Martins", data_inicio_emprego="2026-03-12", formacao=null
- "sou do sexo masculino" → genero="masculino"
- "minha esposa se chama Giselle" → genero="masculino" (inferido por contexto)`;

  try {
    const data = JSON.parse(await callAI(prompt, 400));
    const patch: Record<string, any> = {};

    // full_name: só grava se ainda não existe — nunca sobrescreve
    if (data.nome_completo) {
      const { data: existing } = await supabase
        .from('user_profiles').select('full_name').eq('user_id', userId).maybeSingle();
      if (!existing?.full_name) {
        patch.full_name = data.nome_completo;
      } else {
        // Se vier um nome mais completo (mais palavras), atualiza
        const existingWords = existing.full_name.trim().split(/\s+/).length;
        const newWords      = data.nome_completo.trim().split(/\s+/).length;
        if (newWords > existingWords) patch.full_name = data.nome_completo;
        // Se vier nome mais curto, vai para preferred_name em vez de full_name
        else if (newWords < existingWords && newWords <= 2) {
          patch.preferred_name = data.nome_completo;
        }
      }
    }

    if (data.nome_preferido)      patch.preferred_name = data.nome_preferido;
    if (data.apelido)             patch.nickname       = data.apelido;
    if (data.cidade)              patch.city           = data.cidade;
    if (data.estado)              patch.state          = data.estado;
    if (data.cidade_natal)        patch.birth_city     = data.cidade_natal;
    if (data.estado_natal)        patch.birth_state    = data.estado_natal;
    if (data.nascimento)          patch.birth_date     = data.nascimento;
    if (data.telefone)            patch.phone          = data.telefone;
    if (data.whatsapp)            patch.whatsapp       = data.whatsapp;
    if (data.nome_pai)            patch.father_name    = data.nome_pai;
    if (data.nome_mae)            patch.mother_name    = data.nome_mae;
    if (data.fe)                  patch.faith_profile  = data.fe;
    if (data.fe_notas)            patch.faith_notes    = data.fe_notas;
    if (data.formacao)            patch.profession     = data.formacao;
    if (data.cargo_atual)         patch.current_job    = data.cargo_atual;
    if (data.empresa)             patch.company        = data.empresa;
    if (data.data_inicio_emprego) patch.job_start_date = data.data_inicio_emprego;

    if (data.qtd_irmaos !== null && data.qtd_irmaos !== undefined) {
      patch.siblings_count = parseInt(String(data.qtd_irmaos));
    }

    const escValidos = ['fundamental','medio','tecnico','superior_cursando',
                        'superior_completo','pos_graduacao','mestrado','doutorado'];
    if (data.escolaridade && escValidos.includes(data.escolaridade)) {
      patch.education_level = data.escolaridade;
    }

    if (data.escola) {
      const { data: prof } = await supabase
        .from('user_profiles').select('schools').eq('user_id', userId).maybeSingle();
      const existing: string[] = prof?.schools || [];
      const normalize = (s: string) => s.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const alreadyExists = existing.some(e => normalize(e) === normalize(data.escola));
      if (!alreadyExists) {
        patch.schools = [...existing, data.escola];
      }
    }

    // Gênero: explícito ou inferido (só grava se ainda não está preenchido)
    if (data.genero) {
      const { data: existingProf } = await supabase
        .from('user_profiles').select('gender').eq('user_id', userId).maybeSingle();
      if (!existingProf?.gender) {
        const g = data.genero.toLowerCase();
        patch.gender = g.includes('masc') || g === 'm' ? 'masculino'
                     : g.includes('fem')  || g === 'f' ? 'feminino'
                     : 'prefiro_nao_dizer';
      }
    }

    if (Object.keys(patch).length === 0) return;
    patch.user_id    = userId;
    patch.updated_at = new Date().toISOString();

    const { error } = await supabase.from('user_profiles').upsert(patch, { onConflict: 'user_id' });
    if (error) console.error('[Extrator/perfil] Erro:', JSON.stringify(error));
    else console.log('[Extrator/perfil] Gravou:', Object.keys(patch).filter(k => !['user_id','updated_at'].includes(k)).join(', '));
  } catch (e) {
    console.error('[Extrator/perfil] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: FAMÍLIA
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
${hasEsposaGap ? 'PRIORIDADE: usuário fornecendo nome do cônjuge — extraia com prioridade máxima.' : ''}
${hasFilhoGap  ? 'PRIORIDADE: usuário fornecendo nome de filho — extraia com prioridade máxima.' : ''}

Retorne APENAS JSON (null para não mencionados):

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "esposa":  {"nome": null, "aniversario": null, "telefone": null, "apelido": null},
  "marido":  {"nome": null, "aniversario": null, "telefone": null, "apelido": null},
  "filhos": [{"nome": null, "idade": null, "genero": null, "escola": null, "serie": null, "apelido": null}],
  "pai":    {"nome": null, "apelido": null},
  "mae":    {"nome": null, "apelido": null}
}

REGRAS:
- filhos: retorne [] se nenhum mencionado
- aniversario: DD/MM, YYYY-MM-DD, ou "5 de agosto"
- genero filho: "m" | "f" | null
- apelido: como o usuário chama a pessoa ("vida", "velho", "mãezinha")`;

  try {
    const data = JSON.parse(await callAI(prompt, 400));

    // ── Cônjuge ──────────────────────────────────────────────
    const conjuge = data.esposa?.nome ? data.esposa : data.marido?.nome ? data.marido : null;
    if (conjuge?.nome) {
      const patch: Record<string, any> = {
        user_id:     userId,
        spouse_name: conjuge.nome,
        updated_at:  new Date().toISOString(),};
      if (conjuge.aniversario) patch.spouse_birthday = normalizeDate(conjuge.aniversario);
      if (conjuge.telefone)    patch.spouse_phone    = conjuge.telefone;

      await supabase.from('user_profiles').upsert(patch, { onConflict: 'user_id' });
      console.log('[Extrator/familia] Cônjuge:', conjuge.nome);

      // Salva apelido se mencionado
      if (conjuge.apelido) {
        await upsertAlias(userId, conjuge.apelido, 'spouse', null, conjuge.nome);
      }

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
        birth_date, life_phase, updated_at: new Date().toISOString(),
      };
      if (filho.genero)  childData.gender       = filho.genero;
      if (filho.escola)  childData.school_name  = filho.escola;
      if (filho.serie)   childData.school_grade = filho.serie;
      if (filho.apelido) childData.nickname     = filho.apelido;

      if (ex?.id) {
        await supabase.from('children').update(childData).eq('id', ex.id);
      } else {
        await supabase.from('children').insert({ parent_id: userId, name: filho.nome, ...childData });
      }

      if (filho.apelido) {
        await upsertAlias(userId, filho.apelido, 'child', ex?.id || null, filho.nome);
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

    // ── Pai ──────────────────────────────────────────────────
    if (data.pai?.nome) {
      await supabase.from('user_profiles').upsert(
        { user_id: userId, father_name: data.pai.nome, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
      if (data.pai.apelido) {
        await upsertAlias(userId, data.pai.apelido, 'parent', null, data.pai.nome);
      }
      console.log('[Extrator/familia] Pai:', data.pai.nome);
    }

    // ── Mãe ──────────────────────────────────────────────────
    if (data.mae?.nome) {
      await supabase.from('user_profiles').upsert(
        { user_id: userId, mother_name: data.mae.nome, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
      if (data.mae.apelido) {
        await upsertAlias(userId, data.mae.apelido, 'parent', null, data.mae.nome);
      }
      console.log('[Extrator/familia] Mãe:', data.mae.nome);
    }

  } catch (e) {
    console.error('[Extrator/familia] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: APELIDOS / ALIASES
// "vida", "amor", "velho", "mãezinha"
// ============================================================

async function extractAlias(userId: string, userMessage: string, aiReply: string): Promise<void> {
  // Busca quem o usuário já conhece para ajudar o modelo
  const { data: prof } = await supabase
    .from('user_profiles')
    .select('spouse_name, father_name, mother_name')
    .eq('user_id', userId).maybeSingle();

  const { data: kids } = await supabase
    .from('children').select('name').eq('parent_id', userId);

  const conhecidos = [
    prof?.spouse_name ? `cônjuge: ${prof.spouse_name}` : null,
    prof?.father_name ? `pai: ${prof.father_name}` : null,
    prof?.mother_name ? `mãe: ${prof.mother_name}` : null,
    ...(kids || []).map((k: any) => `filho: ${k.name}`),
  ].filter(Boolean).join(', ');

  const prompt = `Identifique apelidos que o usuário usa para chamar pessoas próximas.

Usuário: "${userMessage}"
Assistente: "${aiReply}"

Pessoas conhecidas: ${conhecidos || 'nenhuma ainda'}

Retorne APENAS JSON:
{
  "aliases": [
    {
      "apelido": "vida",
      "tipo": "spouse",
      "nome_real": "Giselle"
    }
  ]
}

tipos: spouse|child|parent|sibling|friend|other
Retorne aliases: [] se nenhum apelido identificado.`;

  try {
    const data = JSON.parse(await callAI(prompt, 200));
    for (const a of (data.aliases || [])) {
      if (!a.apelido) continue;
      await upsertAlias(userId, a.apelido, a.tipo || 'other', null, a.nome_real || null);
      console.log('[Extrator/alias]', a.apelido, '→', a.nome_real);
    }
  } catch (e) {
    console.error('[Extrator/alias] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: PROJETOS
// ============================================================

async function extractProjeto(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia projetos ou ideias mencionados.
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "projetos": [
    {"nome": null, "tag": null, "descricao": null, "status": null, "contexto_tecnico": null}
  ]
}

tag: slug lowercase sem espaços (ex: "pqf", "lev-app")
status: "ideia"|"em_desenvolvimento"|"beta"|"producao"|"pausado"
Retorne projetos: [] se nenhum mencionado`;

  try {
    const data = JSON.parse(await callAI(prompt, 300));
    for (const proj of (data.projetos || [])) {
      if (!proj.nome || !proj.tag) continue;
      const { error } = await supabase.from('projects').upsert({
        user_id: userId, tag: proj.tag, name: proj.nome,
        description: proj.descricao || null,
        context_technical: proj.contexto_tecnico || null,
        status: proj.status || 'em_desenvolvimento',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tag' });
      if (error) console.error('[Extrator/projeto] Erro:', error);
      else console.log('[Extrator/projeto]', proj.nome);
    }
  } catch (e) {
    console.error('[Extrator/projeto] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: EVENTOS
// ============================================================

async function extractEvento(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia eventos ou datas comemorativas (SEM hora específica).
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "eventos": [
    {"titulo": null, "data": null, "tipo": null, "recorrente": false, "notas": null}
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
        title: ev.titulo, event_date: ev.data,
        category: getCategoryFromType(ev.tipo),
        is_recurring: ev.recorrente ?? w.decay_type === 'recurring_annual',
        notes: ev.notas || null, ...w,
      });
      console.log('[Extrator/evento]', ev.titulo);
    }
  } catch (e) {
    console.error('[Extrator/evento] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: AGENDA
// ============================================================

async function extractAgenda(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia compromissos com data E hora explícitas.
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "compromissos": [
    {"descricao": null, "data_hora": null, "categoria": null}
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
        await supabase.from('agenda').insert({
          user_id: userId, description: comp.descricao,
          event_at: comp.data_hora, category: comp.categoria || 'Pessoal',
        });
        console.log('[Extrator/agenda]', comp.descricao);
      }
    }
  } catch (e) {
    console.error('[Extrator/agenda] Erro:', e);
  }
}

// ============================================================
// EXTRATOR: ROTINA
// ============================================================

async function extractRotina(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia informações de rotina mencionadas explicitamente.
Retorne APENAS JSON (null para não mencionados):

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{"despertar": null, "dormir": null, "academia_horario": null, "trabalho_entrada": null, "trabalho_saida": null, "lembretes": []}`;

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
// EXTRATOR: PREFERÊNCIAS
// ============================================================

async function extractPreferencia(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia preferências pessoais mencionadas.
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{"preferencias": [{"tipo": "lugar", "descricao": "Feira do Produtor aos sábados"}]}

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
      supabase.from('children').select('name, birth_date, life_phase').eq('parent_id', userId),
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

    if (p?.full_name)       patches['Nome']         = p.preferred_name ? `${p.full_name} (${p.preferred_name})` : p.full_name;
    if (p?.city)            patches['Localização']  = `${p.city}${p.state ? `, ${p.state}` : ''}`;
    if (p?.birth_city)      patches['Origem']       = `${p.birth_city}${p.birth_state ? `, ${p.birth_state}` : ''}`;
    if (p?.birth_date)      patches['Nascimento']   = p.birth_date;
    if (p?.profession)      patches['Formação']     = p.profession;
    if (p?.current_job)     patches['Cargo']        = `${p.current_job}${p.company ? ` @ ${p.company}` : ''}${p.job_start_date ? ` (início: ${p.job_start_date})` : ''}`;
    if (p?.faith_profile && p.faith_profile !== 'unknown') patches['Fé'] = p.faith_profile;
    if (p?.spouse_name)     patches['Cônjuge']      = `${p.spouse_name}${p.spouse_birthday ? ` (aniv: ${p.spouse_birthday})` : ''}`;
    if (p?.father_name)     patches['Pai']          = p.father_name;
    if (p?.mother_name)     patches['Mãe']          = p.mother_name;
    if (p?.education_level) patches['Educação']     = p.education_level;

    if (kids.length > 0) {
      patches['Filhos'] = kids.map((k: any) => {
        const age = k.birth_date
          ? new Date().getFullYear() - new Date(k.birth_date).getFullYear()
          : null;
        return `${k.name}${age ? ` (${age} anos)` : ''}`;
      }).join(', ');
    }

    for (const [key, val] of Object.entries(patches)) {
      const rx   = new RegExp(`- ${key}:.*`, 'i');
      const line = `- ${key}: ${val}`;
      ctx = rx.test(ctx) ? ctx.replace(rx, line) : `${ctx}\n${line}`;
    }

    if (proj.length > 0) {
      const block   = proj.map((r: any) => `- ${r.name}${r.status ? ` [${r.status}]` : ''}: ${r.description || ''}`).join('\n');
      const section = `## PROJETOS\n${block}`;
      ctx = /## PROJETOS[\s\S]*?(?=\n##|$)/i.test(ctx)
        ? ctx.replace(/## PROJETOS[\s\S]*?(?=\n##|$)/i, section)
        : `${ctx}\n\n${section}`;
    }

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
  return (data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
}

async function upsertAlias(
  userId: string,
  alias: string,
  type: string,
  referId: string | null,
  referName: string | null
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

async function upsertEvent(userId: string, ev: {
  title: string; event_date: string; category: string;
  priority: string; decay_type: string; emotional_weight: number;
  is_recurring?: boolean; notes?: string | null;
}): Promise<void> {
  const { data: ex } = await supabase.from('events').select('id')
    .eq('user_id', userId).ilike('title', ev.title).maybeSingle();

  if (ex?.id) {
    await supabase.from('events').update({
      event_date: ev.event_date, priority: ev.priority,
      decay_type: ev.decay_type, emotional_weight: ev.emotional_weight,
      notes: ev.notes || null,
    }).eq('id', ex.id);
  } else {
    await supabase.from('events').insert({
      user_id: userId, title: ev.title, event_date: ev.event_date,
      category: ev.category, priority: ev.priority, decay_type: ev.decay_type,
      emotional_weight: ev.emotional_weight,
      is_recurring: ev.is_recurring ?? ev.decay_type === 'recurring_annual',
      notes: ev.notes || null,
      last_notified_year: new Date().getFullYear() - 1,
      relevance_score: 1.0,
    });
  }
}

function normalizeDate(raw: string): string {
  if (!raw) return raw;
  const months: Record<string, string> = {
    janeiro:'01', fevereiro:'02', marco:'03', abril:'04',
    maio:'05', junho:'06', julho:'07', agosto:'08',
    setembro:'09', outubro:'10', novembro:'11', dezembro:'12',
  };
  const year    = new Date().getFullYear();
  const ptMatch = raw.match(/(\d{1,2})\s+de?\s+(\w+)/i);
  if (ptMatch) {
    const mon = months[ptMatch[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')];
    if (mon) return `${year}-${mon}-${ptMatch[1].padStart(2, '0')}`;
  }
  const parts = raw.split(/[-/]/);
  if (parts.length === 2) return `${year}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  if (parts.length === 3) return raw;
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
  if (age <= 3)  return 'baby';
  if (age <= 11) return 'child';
  if (age <= 17) return 'teen';
  if (age <= 24) return 'young_adult';
  return 'adult';
}