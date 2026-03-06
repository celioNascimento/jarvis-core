// ============================================================
// lib/extractor.ts
// Parte 1: exports, classify, gaps, perfil, familia, alias
// Importa jobs de lib/extractor-jobs.ts
// ============================================================

import { createClient } from '@supabase/supabase-js';
import {
  extractProjeto, extractEvento, extractAgenda,
  extractRotina, extractPreferencia, updateL3,
  callAI, upsertAlias, upsertEvent, normalizeDate,
  getCategoryFromType, getLifePhase,
} from '@/lib/extractor-jobs';

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

// ============================================================
// BLOCO DE GAPS PARA O PROMPT DO WEBHOOK
// ============================================================

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
  } catch { return ''; }
}

// ============================================================
// EXTRAÇÃO COM RESUMO — roda ANTES da resposta do Jarvis
// ============================================================

export async function extractAndSummarize(
  userId: string,
  userName: string,
  userMessage: string
): Promise<string> {
  try {
    const { data: userData } = await supabase
      .from('users').select('pending_gaps').eq('id', userId).single();
    const pendingGaps: DetectedGap[] = userData?.pending_gaps || [];
    const gapsCtx = pendingGaps.length > 0
      ? `Gaps aguardando resposta: ${pendingGaps.map(g => `${g.field} (${g.context})`).join('; ')}`
      : '';

    const classification = await classify(userMessage, gapsCtx);
    if (!classification.has_new_facts) return '';

    const gaps = await detectGaps(userId, userMessage, classification.contexts, pendingGaps);
    if (gaps.length > 0) {
      await supabase.from('users').update({ pending_gaps: gaps }).eq('id', userId);
    } else if (pendingGaps.length > 0) {
      await supabase.from('users').update({ pending_gaps: [] }).eq('id', userId);
    }

    const tasks: Promise<void>[] = [];
    if (classification.contexts.includes('perfil'))      tasks.push(extractPerfil(userId, userMessage));
    if (classification.contexts.includes('familia'))     tasks.push(extractFamilia(userId, userMessage, pendingGaps));
    if (classification.contexts.includes('alias'))       tasks.push(extractAlias(userId, userMessage));
    if (classification.contexts.includes('projeto'))     tasks.push(extractProjeto(userId, userMessage));
    if (classification.contexts.includes('evento'))      tasks.push(extractEvento(userId, userMessage));
    if (classification.contexts.includes('agenda'))      tasks.push(extractAgenda(userId, userMessage));
    if (classification.contexts.includes('rotina'))      tasks.push(extractRotina(userId, userMessage));
    if (classification.contexts.includes('preferencia')) tasks.push(extractPreferencia(userId, userMessage));

    const results = await Promise.allSettled(tasks);
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`[Extrator] Task ${i} falhou:`, r.reason);
    });

    await updateL3(userId);
    return summarizeContexts(classification.contexts);
  } catch (e) {
    console.error('[Extrator/summarize] Erro:', e);
    return '';
  }
}

// Mantido para compatibilidade mas não usado diretamente pelo webhook
export async function extractAndRoute(
  userId: string,
  userName: string,
  userMessage: string,
  aiReply: string
): Promise<void> {
  await extractAndSummarize(userId, userName, userMessage);
}

function summarizeContexts(contexts: string[]): string {
  const labels: Record<string, string> = {
    perfil:      'dados do seu perfil',
    familia:     'informações da sua família',
    alias:       'apelido registrado',
    projeto:     'projeto anotado',
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

// ============================================================
// CLASSIFICADOR
// ============================================================

async function classify(
  userMessage: string,
  gapsCtx: string
): Promise<Classification> {
  const prompt = `Analise a mensagem e identifique contextos com FATOS NOVOS sobre o usuário.

Mensagem do usuário: "${userMessage}"
${gapsCtx ? `\n${gapsCtx}` : ''}

Contextos disponíveis:
- "perfil": nome completo, nome preferido, apelido pessoal, cidade/estado atual ou natal,
            data de nascimento, gênero, telefone, whatsapp,
            nome do pai, nome da mãe, quantidade de irmãos, fé/religião,
            formação acadêmica (curso/área), cargo/emprego atual ou futuro,
            empresa, data início emprego, escola/faculdade cursada
- "familia": esposa/marido (nome, aniversário, telefone), filhos (nome, idade, escola, série, turno, creche, ensino médio, necessidades especiais), nome da mãe/pai de um filho específico
- "alias": apelido que o usuário usa para chamar alguém ("vida"=esposa, "velho"=pai)
- "projeto": projetos, ideias, apps, negócios que desenvolve ou quer desenvolver
- "evento": aniversários, festas, datas comemorativas recorrentes (sem hora específica)
- "agenda": compromissos com data E hora específica (consulta, reunião, voo)
- "rotina": horários fixos, hábitos diários, lembretes recorrentes
- "preferencia": gostos, lugares favoritos, comidas, hobbies, opiniões

REGRAS:
- Analise APENAS o que o USUÁRIO afirma — ignore perguntas ou afirmações do assistente
- has_new_facts: true se QUALQUER fato pessoal for afirmado pelo usuário
- has_new_facts: false APENAS para saudações, piadas, perguntas genéricas sem info pessoal
- Se gaps indicarem campo pendente e usuário responder → inclua o contexto correto

Retorne APENAS JSON:
{"has_new_facts": true, "contexts": ["perfil"]}`;

  try {
    return JSON.parse(await callAI(prompt, 200));
  } catch {
    return { has_new_facts: false, contexts: [] };
  }
}

// ============================================================
// DETECTOR DE GAPS
// Consulta TODOS os campos antes de criar gaps
// ============================================================

async function detectGaps(
  userId: string,
  userMessage: string,
  contexts: string[],
  existingGaps: DetectedGap[]
): Promise<DetectedGap[]> {
  if (contexts.length === 0) return [];

  // Busca perfil COMPLETO para evitar perguntar o que já sabemos
  const [profileRes, childrenRes] = await Promise.all([
    supabase.from('user_profiles')
      .select(`full_name, preferred_name, spouse_name, city, current_job,
               father_name, mother_name, profession, phone, whatsapp,
               birth_date, birth_city, education_level, faith_profile,
               siblings_count, gender`)
      .eq('user_id', userId).maybeSingle(),
    supabase.from('children').select('name').eq('parent_id', userId),
  ]);

  const p          = profileRes.data;
  const childNames = (childrenRes.data || []).map((c: any) => c.name);

  const prompt = `Identifique lacunas de informação. Máximo 2 gaps relevantes.

Mensagem do usuário: "${userMessage}"

O que JÁ SABEMOS (não pergunte o que já está preenchido):
- Nome completo: ${p?.full_name || 'desconhecido'}
- Como prefere ser chamado: ${p?.preferred_name || 'não informado'}
- Gênero: ${p?.gender || 'desconhecido'}
- Cônjuge: ${p?.spouse_name || 'desconhecido'}
- Pai: ${p?.father_name || 'desconhecido'}
- Mãe: ${p?.mother_name || 'desconhecida'}
- Filhos: ${childNames.join(', ') || 'nenhum'}
- Cidade: ${p?.city || 'desconhecida'}
- Telefone: ${p?.phone || 'desconhecido'}
- WhatsApp: ${p?.whatsapp || 'desconhecido'}
- Data nascimento: ${p?.birth_date || 'desconhecida'}
- Cidade natal: ${p?.birth_city || 'desconhecida'}
- Formação: ${p?.profession || 'desconhecida'}
- Cargo: ${p?.current_job || 'desconhecido'}
- Escolaridade: ${p?.education_level || 'desconhecida'}
- Fé: ${p?.faith_profile || 'desconhecida'}
- Irmãos: ${p?.siblings_count !== null && p?.siblings_count !== undefined ? p.siblings_count : 'desconhecido'}

Contextos detectados: ${contexts.join(', ')}

REGRA: Só crie gap para campos que estão como "desconhecido" E que são relevantes para o contexto.
Se o campo já está preenchido → NÃO crie gap para ele.

Campos válidos para gaps:
nome_completo, nome_esposa, nome_marido, nome_filho, nome_pai, nome_mae,
data_nascimento_filho, tema_evento, data_evento, nome_medico, nome_projeto

Retorne APENAS JSON:
{"gaps": [{"field": "nome_esposa", "context": "cônjuge mencionado sem nome", "hint": "E como ela se chama?", "urgencia": "alta"}]}
urgencia: "alta"|"media"|"baixa"
Retorne {"gaps": []} se não há lacunas ou se já sabemos tudo.`;

  try {
    const data = JSON.parse(await callAI(prompt, 300));
    return (data.gaps || []).filter((g: DetectedGap) => g.urgencia !== 'baixa');
  } catch { return []; }
}

// ============================================================
// EXTRATOR: PERFIL COMPLETO
// 1 query inicial para buscar estado atual, evita múltiplas queries
// ============================================================

async function extractPerfil(userId: string, userMessage: string): Promise<void> {
  // Busca perfil atual UMA VEZ para usar em todas as verificações
  const { data: current } = await supabase
    .from('user_profiles')
    .select('full_name, preferred_name, gender, schools')
    .eq('user_id', userId).maybeSingle();

  const prompt = `Extraia dados de perfil pessoal afirmados explicitamente pelo USUÁRIO.
IGNORE qualquer informação vinda de perguntas ou afirmações do assistente.

Mensagem do usuário: "${userMessage}"

Retorne APENAS JSON (null para campos não mencionados):
{
  "nome_completo": null, "nome_preferido": null, "apelido": null,
  "cidade": null, "estado": null, "cidade_natal": null, "estado_natal": null,
  "nascimento": null, "genero": null, "telefone": null, "whatsapp": null,
  "nome_pai": null, "nome_mae": null, "qtd_irmaos": null,
  "fe": null, "fe_notas": null,
  "formacao": null, "cargo_atual": null, "empresa": null, "data_inicio_emprego": null,
  "escolaridade": null, "escola": null
}

REGRAS:
- FONTE: extraia APENAS do que o USUÁRIO afirma. Perguntas do assistente = ignorar
- nome_completo: só com sobrenome(s). "Celio Roberto Ramos do Nascimento" → extrai tudo
  "pode me chamar de X" → NÃO é nome_completo, é nome_preferido
- nome_preferido: APENAS quando usuário disser explicitamente como quer ser chamado.
  "pode me chamar de X", "prefiro X", "me chama de X" → nome_preferido="X"
  NUNCA inferir de contexto, nome de terceiros ou perguntas do assistente
- cidade/estado: infira estado pela cidade (Londrina→PR, São Paulo→SP). Estado = sigla 2 letras
- cidade_natal ≠ cidade: natal=onde nasceu, cidade=onde mora AGORA
- telefone: "telefone", "celular", "número", "fone", "contato"
- whatsapp: "whatsapp", "wpp", "zap"
- formacao: ÁREA DE ESTUDO ("Engenharia de Computação"). NÃO é cargo nem empresa
- cargo_atual: FUNÇÃO/CARGO ("Técnico Jr"). NÃO é área de estudo
- empresa: empresa onde trabalha/vai trabalhar. NÃO é escola/faculdade
- data_inicio_emprego: "a partir de 12/03/2026" → "2026-03-12". Formato YYYY-MM-DD
- escola: instituição de ensino. NÃO é empresa
- escolaridade: "fundamental"|"medio"|"tecnico"|"superior_cursando"|"superior_completo"|"pos_graduacao"|"mestrado"|"doutorado"
- fe: "christian_declared"|"open"|"none"
- genero: "masculino"|"feminino" explícito, ou inferido: "minha esposa"→masculino, "meu marido"→feminino
- qtd_irmaos: número inteiro`;

  try {
    const data = JSON.parse(await callAI(prompt, 400));
    const patch: Record<string, any> = {};

    // Escudo universal: só atualiza campo se melhorar o que já existe
    function set(field: string, newVal: any, type: 'name'|'once'|'array'|'number' = 'once') {
      if (newVal === null || newVal === undefined || newVal === '') return;
      const cur = (current as any)?.[field];
      if (type === 'name') {
        const curWords = cur ? cur.trim().split(/\s+/).length : 0;
        const newWords = String(newVal).trim().split(/\s+/).length;
        if (!cur || newWords > curWords) patch[field] = newVal;
      } else if (type === 'array') {
        const existing: string[] = cur || [];
        const norm = (s: string) => s.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (!existing.some((e: string) => norm(e) === norm(String(newVal)))) {
          patch[field] = [...existing, newVal];
        }
      } else if (type === 'number') {
        if (cur === null || cur === undefined) patch[field] = newVal;
      } else {
        if (!cur) patch[field] = newVal;
      }
    }

    set('full_name',      data.nome_completo,      'name');
    // preferred_name: atualiza sempre que usuário afirmar explicitamente
    if (data.nome_preferido) patch.preferred_name = data.nome_preferido;
    set('nickname',       data.apelido,             'once');
    set('city',           data.cidade,              'once');
    set('state',          data.estado,              'once');
    set('birth_city',     data.cidade_natal,        'once');
    set('birth_state',    data.estado_natal,        'once');
    set('birth_date',     data.nascimento,          'once');
    set('phone',          data.telefone,            'once');
    set('whatsapp',       data.whatsapp,            'once');
    set('father_name',    data.nome_pai,            'name');
    set('mother_name',    data.nome_mae,            'name');
    set('faith_profile',  data.fe,                  'once');
    set('faith_notes',    data.fe_notas,            'once');
    set('profession',     data.formacao,            'once');
    set('current_job',    data.cargo_atual,         'once');
    set('company',        data.empresa,             'once');
    set('job_start_date', data.data_inicio_emprego, 'once');
    set('schools',        data.escola,              'array');

    if (data.qtd_irmaos !== null && data.qtd_irmaos !== undefined) {
      set('siblings_count', parseInt(String(data.qtd_irmaos)), 'number');
    }

    const escValidos = ['fundamental','medio','tecnico','superior_cursando',
                        'superior_completo','pos_graduacao','mestrado','doutorado'];
    if (data.escolaridade && escValidos.includes(data.escolaridade)) {
      set('education_level', data.escolaridade, 'once');
    }

    // genero: só grava se vazio (campo sensível — não inferir depois de definido)
    if (data.genero && !current?.gender) {
      const g = data.genero.toLowerCase();
      patch.gender = g.includes('masc') || g === 'm' ? 'masculino'
                   : g.includes('fem')  || g === 'f' ? 'feminino'
                   : 'prefiro_nao_dizer';
    }
    if (Object.keys(patch).length === 0) return;
    patch.user_id    = userId;
    patch.updated_at = new Date().toISOString();

    const { error } = await supabase.from('user_profiles').upsert(patch, { onConflict: 'user_id' });
    if (error) console.error('[Extrator/perfil] Erro:', JSON.stringify(error));
    else console.log('[Extrator/perfil] Gravou:', Object.keys(patch).filter(k => !['user_id','updated_at'].includes(k)).join(', '));
  } catch (e) { console.error('[Extrator/perfil] Erro:', e); }
}

// ============================================================
// EXTRATOR: FAMÍLIA
// Verifica o que já existe antes de sobrescrever
// ============================================================

async function extractFamilia(
  userId: string,
  userMessage: string,
  gaps: DetectedGap[]
): Promise<void> {
  const hasEsposaGap = gaps.some(g => g.field === 'nome_esposa' || g.field === 'nome_marido');
  const hasFilhoGap  = gaps.some(g => g.field === 'nome_filho');

  // Busca o que já existe para não sobrescrever com dados piores
  const { data: current } = await supabase
    .from('user_profiles')
    .select('spouse_name, spouse_birthday, father_name, mother_name')
    .eq('user_id', userId).maybeSingle();

  const prompt = `Extraia dados familiares afirmados explicitamente pelo USUÁRIO.
IGNORE qualquer informação vinda de perguntas ou afirmações do assistente.
${hasEsposaGap ? 'PRIORIDADE: usuário fornecendo nome do cônjuge — extraia.' : ''}
${hasFilhoGap  ? 'PRIORIDADE: usuário fornecendo nome de filho — extraia.' : ''}

Mensagem do usuário: "${userMessage}"

Retorne APENAS JSON (null para não mencionados):
{
  "esposa":  {"nome": null, "aniversario": null, "telefone": null, "apelido": null},
  "marido":  {"nome": null, "aniversario": null, "telefone": null, "apelido": null},
  "filhos": [{"nome": null, "nascimento": null, "idade": null, "genero": null, "pronome": null, "escola": null, "serie": null, "turno": null, "nivel_escolar": null, "necessidades_especiais": null, "apelido": null, "outro_pai": null}],
  "pai":    {"nome": null, "apelido": null},
  "mae":    {"nome": null, "apelido": null}
}

REGRAS:
- filhos: [] se nenhum mencionado
- nascimento: data exata se informada, formato YYYY-MM-DD. Tem precedência sobre idade
- aniversario: DD/MM, YYYY-MM-DD, ou "5 de agosto"
- genero: "m"|"f"|null — extraia de "ele"/"ela", "meu filho"/"minha filha", ou declaração explícita
- pronome: "ele"|"ela"|null — pronome usado na mensagem para referir ao filho
- apelido: como o usuário chama a pessoa ("vida", "velho", "mãezinha")
- serie: série/ano escolar exato ("P5", "1º ano", "3º médio") ou tipo ("creche", "maternal")
- nivel_escolar: "creche"|"pre"|"fundamental"|"medio"|"superior"|"nao_estuda" — infira do contexto
  "creche" → nivel_escolar="creche" | "P5" → nivel_escolar="pre" | "ensino médio concluído" → nivel_escolar="nao_estuda"
- turno: "manha"|"tarde"|"integral"|"noite"|null
- necessidades_especiais: array de strings se mencionado, ex: ["autismo"] | null se não mencionado
- outro_pai: nome do outro pai/mãe biológico SE mencionado
  "a mãe do Davi é Giselle" → outro_pai="Giselle"
  "é de um casamento anterior" → outro_pai="desconhecido"
  "filho da Ana" → outro_pai="Ana"
  null se não mencionado`;

  try {
    const data = JSON.parse(await callAI(prompt, 400));

    // ── Cônjuge ──────────────────────────────────────────────
    const conjuge = data.esposa?.nome ? data.esposa : data.marido?.nome ? data.marido : null;
    if (conjuge?.nome) {
      const patch: Record<string, any> = { user_id: userId, updated_at: new Date().toISOString() };
      // Só atualiza nome se ainda não tinha ou se vier nome mais completo
      if (!current?.spouse_name || conjuge.nome.split(' ').length > current.spouse_name.split(' ').length) {
        patch.spouse_name = conjuge.nome;
      }
      if (conjuge.aniversario && !current?.spouse_birthday) {
        patch.spouse_birthday = normalizeDate(conjuge.aniversario);
      }
      if (conjuge.telefone) patch.spouse_phone = conjuge.telefone;

      await supabase.from('user_profiles').upsert(patch, { onConflict: 'user_id' });
      if (conjuge.apelido) await upsertAlias(userId, conjuge.apelido, 'spouse', null, conjuge.nome);
      if (conjuge.aniversario) {
        await upsertEvent(userId, {
          title: `Aniversário ${conjuge.nome}`,
          event_date: normalizeDate(conjuge.aniversario),
          category: 'family',
          priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 0.95,
        });
      }
      console.log('[Extrator/familia] Cônjuge:', conjuge.nome);
    }

    // ── Filhos ───────────────────────────────────────────────
    for (const filho of (data.filhos || [])) {
      if (!filho.nome) continue;

      const firstName = filho.nome.split(' ')[0].toLowerCase();

      // Match por primeiro nome (case-insensitive) — evita duplicação
      const { data: allChildren } = await supabase.from('children')
        .select('id, name, birth_date, nickname, child_user_id')
        .eq('parent_id', userId);

      const ex = (allChildren || []).find((c: any) =>
        c.name.split(' ')[0].toLowerCase() === firstName
      ) || null;

      // Nascimento: data exata tem precedência sobre idade
      let birth_date: string | null = null;
      if (filho.nascimento) {
        birth_date = normalizeDate(filho.nascimento);
      } else if (filho.idade) {
        birth_date = `${new Date().getFullYear() - filho.idade}-01-01`;
      }

      // Idade real a partir da data de nascimento
      const ageReal = birth_date
        ? Math.floor((Date.now() - new Date(birth_date).getTime()) / (1000 * 60 * 60 * 24 * 365.25))
        : filho.idade;
      const life_phase = getLifePhase(ageReal);

      // Nome: só atualiza se vier mais completo
      const existingName  = ex?.name || '';
      const existingWords = existingName.trim().split(/\s+/).length;
      const newWords      = filho.nome.trim().split(/\s+/).length;
      const nameToSave    = (!existingName || newWords > existingWords) ? filho.nome : existingName;

      // Nickname: se filho tem conta no app, usa preferred_name da conta
      let nicknameToSave: string | null = ex?.nickname || null;
      if (ex?.child_user_id) {
        const { data: childUser } = await supabase
          .from('user_profiles').select('preferred_name, full_name')
          .eq('user_id', String(ex.child_user_id)).maybeSingle();
        nicknameToSave = childUser?.preferred_name || childUser?.full_name?.split(' ')[0] || null;
      } else {
        // Sem conta: padrão = primeiro nome quando apelido não informado
        const apelido  = filho.apelido || nameToSave.split(' ')[0];
        const apWords  = apelido.trim().split(/\s+/).length;
        const curWords = (ex?.nickname || '').trim().split(/\s+/).length;
        if (!ex?.nickname || apWords > curWords) nicknameToSave = apelido;
      }

      // Normaliza gênero para valores aceitos pelo CHECK constraint
      let generoNorm: string | null = null;
      if (filho.genero) {
        const g = filho.genero.toLowerCase();
        generoNorm = (g === 'm' || g.startsWith('masc')) ? 'masculino'
                   : (g === 'f' || g.startsWith('fem'))  ? 'feminino' : 'outro';
      } else if (filho.pronome) {
        generoNorm = filho.pronome === 'ele' ? 'masculino' : filho.pronome === 'ela' ? 'feminino' : null;
      }

      const childData: Record<string, any> = {
        name: nameToSave,
        updated_at: new Date().toISOString(),
      };
      // Só inclui birth_date e life_phase se tiver valor — nunca sobrescreve com null
      if (birth_date)  childData.birth_date  = birth_date;
      if (life_phase && (!ex || birth_date)) childData.life_phase = life_phase;
      if (nicknameToSave)              childData.nickname          = nicknameToSave;
      if (generoNorm)                  childData.gender             = generoNorm;
      if (filho.escola)                childData.school_name        = filho.escola;
      if (filho.serie)                 childData.school_grade       = filho.serie;
      if (filho.turno)                 childData.school_shift       = filho.turno;
      if (filho.necessidades_especiais) childData.special_needs     = filho.necessidades_especiais;
      if (filho.outro_pai)             childData.other_parent_name  = filho.outro_pai === 'desconhecido' ? null : filho.outro_pai;

      // nivel_escolar → life_phase override + school_grade quando creche/pre
      if (filho.nivel_escolar) {
        const nivelMap: Record<string, string> = {
          creche: 'baby', pre: 'child', fundamental: 'child',
          medio: 'teen', superior: 'young_adult', nao_estuda: life_phase,
        };
        if (nivelMap[filho.nivel_escolar]) childData.life_phase = nivelMap[filho.nivel_escolar];
        if (!filho.serie && ['creche','pre'].includes(filho.nivel_escolar)) {
          childData.school_grade = filho.nivel_escolar;
        }
        if (filho.nivel_escolar === 'nao_estuda') {
          childData.school_name  = null;
          childData.school_grade = null;
        }
      }

      let childId: string;
      if (ex?.id) {
        await supabase.from('children').update(childData).eq('id', ex.id);
        childId = ex.id;
      } else {
        const { data: inserted } = await supabase.from('children')
          .insert({ parent_id: userId, ...childData }).select('id').single();
        childId = inserted?.id;
      }

      // Alias: só cria se apelido ≠ primeiro nome
      if (nicknameToSave && nicknameToSave.toLowerCase() !== firstName) {
        await upsertAlias(userId, nicknameToSave, 'child', childId || null, nameToSave);
      }

      if (birth_date) {
        await upsertEvent(userId, {
          title: `Aniversário ${nameToSave}`, event_date: birth_date, category: 'family',
          notes: `${life_phase} — ${ageReal} anos`,
          priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 0.90,
        });
      }
      console.log('[Extrator/familia] Filho:', nameToSave, ex ? '(atualizado)' : '(novo)');
    }

    // ── Pai ──────────────────────────────────────────────────
    if (data.pai?.nome && !current?.father_name) {
      await supabase.from('user_profiles').upsert(
        { user_id: userId, father_name: data.pai.nome, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
      if (data.pai.apelido) await upsertAlias(userId, data.pai.apelido, 'parent', null, data.pai.nome);
      console.log('[Extrator/familia] Pai:', data.pai.nome);
    }

    // ── Mãe ──────────────────────────────────────────────────
    if (data.mae?.nome && !current?.mother_name) {
      await supabase.from('user_profiles').upsert(
        { user_id: userId, mother_name: data.mae.nome, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
      if (data.mae.apelido) await upsertAlias(userId, data.mae.apelido, 'parent', null, data.mae.nome);
      console.log('[Extrator/familia] Mãe:', data.mae.nome);
    }

  } catch (e) { console.error('[Extrator/familia] Erro:', e); }
}

// ============================================================
// EXTRATOR: APELIDOS / ALIASES
// ============================================================

async function extractAlias(userId: string, userMessage: string): Promise<void> {
  const { data: prof } = await supabase
    .from('user_profiles').select('spouse_name, father_name, mother_name').eq('user_id', userId).maybeSingle();
  const { data: kids } = await supabase.from('children').select('name').eq('parent_id', userId);

  const conhecidos = [
    prof?.spouse_name ? `cônjuge: ${prof.spouse_name}` : null,
    prof?.father_name ? `pai: ${prof.father_name}` : null,
    prof?.mother_name ? `mãe: ${prof.mother_name}` : null,
    ...(kids || []).map((k: any) => `filho: ${k.name}`),
  ].filter(Boolean).join(', ');

  const prompt = `Identifique apelidos que o usuário usa para chamar pessoas próximas.

Mensagem do usuário: "${userMessage}"
Pessoas conhecidas: ${conhecidos || 'nenhuma ainda'}

Retorne APENAS JSON:
{"aliases": [{"apelido": "vida", "tipo": "spouse", "nome_real": "Giselle"}]}

tipos: spouse|child|parent|sibling|friend|other
Retorne aliases: [] se nenhum identificado.`;

  try {
    const data = JSON.parse(await callAI(prompt, 200));
    for (const a of (data.aliases || [])) {
      if (!a.apelido) continue;
      await upsertAlias(userId, a.apelido, a.tipo || 'other', null, a.nome_real || null);
      console.log('[Extrator/alias]', a.apelido, '→', a.nome_real);
    }
  } catch (e) { console.error('[Extrator/alias] Erro:', e); }
}