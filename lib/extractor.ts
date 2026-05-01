// ============================================================
// lib/extractor.ts
// Parte 1: exports, classify, gaps, perfil, familia, alias
// Importa jobs de lib/extractor-jobs.ts
// ============================================================

import { createClient } from '@supabase/supabase-js';
import {
  extractProjeto, extractEvento, extractAgenda,
  extractRotina, extractPreferencia, extractRecomendacao, updateL3,
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
// GUARD — valida que userId é bigint numérico
// Bloqueia UUID do Auth em qualquer ponto de entrada público
// ============================================================

function assertNumericUserId(userId: string, caller: string): void {
  if (!/^\d+$/.test(userId)) {
    throw new Error(
      `[${caller}] FATAL: userId não é bigint numérico — recebeu: "${userId}". ` +
      `Verifique se numericUserIdStr está sendo passado corretamente pelo chamador.`
    );
  }
}

// ============================================================
// BLOCO DE GAPS PARA O PROMPT DO WEBHOOK
// ============================================================

export async function buildGapsBlock(userId: string, currentMessage?: string): Promise<string> {
  assertNumericUserId(userId, 'buildGapsBlock');
  try {
    const { data } = await supabase
      .from('users').select('pending_gaps').eq('id', userId).single();
    const gaps: DetectedGap[] = data?.pending_gaps || [];
    if (gaps.length === 0) return '';

    // Detecta se a mensagem atual tem contexto incompatível com os gaps pendentes
    const msgLower = (currentMessage || '').toLowerCase();
    const isEmotional = /dific|barra|trist|saudade|relação|família|filho|esposa|mãe|pai|deus|fé|oração/.test(msgLower);
    const isAboutDate = /aniversário|data|nascimento|casamento|páscoa|natal/.test(msgLower);
    const isAboutWork = /trabalho|projeto|empresa|reunião|entrega|prazo|cliente/.test(msgLower);
    const hasProjectGap = gaps.some(g => (g.field || '').match(/projeto|pqf/i));
    const blockProjectGap = hasProjectGap && !isAboutWork;

    const lines = gaps
      .map(g => `- [${(g.urgencia || 'media').toUpperCase()}] ${g.context}\n  → ${g.hint}`)
      .join('\n');

    const isEmotionalStrict = isEmotional;
    const temAberturaReal = !isEmotionalStrict && !isAboutDate && !blockProjectGap;

    // Silêncio total — não injeta no prompt se contexto for incompatível
    if (!temAberturaReal) return '';

    return [
      '[LEMBRETE INTERNO — pergunte apenas se cair naturalmente na conversa]',
      lines,
      'Faça UMA pergunta, de forma leve, apenas se o assunto já estiver próximo.',
    ].join('\n');
  } catch { return ''; }
}

// ============================================================
// EXTRAÇÃO COM RESUMO — roda ANTES da resposta do Jarvis
// ============================================================

export async function extractAndSummarize(
  userId: string,
  userName: string,
  userMessage: string,
  aiReply: string = ''
): Promise<string> {
  // ── GUARD: bloqueia UUID do Auth aqui — ponto de entrada principal ──
  assertNumericUserId(userId, 'extractAndSummarize');

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
    console.log('[Extrator/classify] contextos:', classification.contexts);
    const msg = userMessage.toLowerCase();

    const temPerfil = classification.contexts.includes('perfil');
    const temFamilia = classification.contexts.includes('familia');
    const temEvento = classification.contexts.includes('evento');
    const temProjeto = classification.contexts.includes('projeto');
    const temAgenda = classification.contexts.includes('agenda');
    const temRotina = classification.contexts.includes('rotina');
    const temPref = classification.contexts.includes('preferencia');
    const temRelacao = classification.contexts.includes('relacao');
    const temRec = classification.contexts.includes('recomendacao');
    const temAlias = classification.contexts.includes('alias');

    // Filtros semânticos — só roda se a mensagem realmente falar do assunto
    const msgFamilia = /filho|filha|esposa|marido|cônjuge|pai|mãe|irmão|irmã|bebê|criança|nasceu|grávid/.test(msg);
    const msgProjeto = /projeto|app|sistema|negócio|ideia|desenvolv|startup|pqf/.test(msg);
    const msgAgenda = /\d{1,2}[\/\-:h]\d|às \d|amanhã|semana que vem|consulta|reunião|voo|compromisso/.test(msg);
    const msgRotina = /todo dia|toda manhã|sempre|rotina|hábito|costume|horário|acord|dorm/.test(msg);
    const msgRelacao = /não (nos|me|se) (damos|dou|fala)|relação|difícil|distante|próximo|me dou bem/.test(msg);
    const msgAlias = /chamo|chama|apelido|me chama de|chamo de/.test(msg);

    if (temPerfil) tasks.push(extractPerfil(userId, userMessage));
    if (temFamilia && msgFamilia) tasks.push(extractFamilia(userId, userMessage, pendingGaps));
    if (temAlias && msgAlias) tasks.push(extractAlias(userId, userMessage));
    if (temProjeto && msgProjeto) tasks.push(extractProjeto(userId, userMessage));
    // extractEvento REMOVIDO — eventos são inseridos exclusivamente pelo webhook
    // via gatilho SALVAR_EVENTO. Dois caminhos = race condition + duplicatas.
    if (temAgenda && msgAgenda) tasks.push(extractAgenda(userId, userMessage));
    if (temRotina && msgRotina) tasks.push(extractRotina(userId, userMessage));
    if (temPref) tasks.push(extractPreferencia(userId, userMessage));
    if (temRelacao && msgRelacao) tasks.push(extractRelacao(userId, userMessage));
    if (temRec) tasks.push(extractRecomendacao(userId, userMessage, aiReply));

    console.log('[Extrator/tasks]', tasks.length, 'tarefas ativas de', classification.contexts.length, 'contextos');

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
    perfil: 'dados do seu perfil',
    familia: 'informações da sua família',
    alias: 'apelido registrado',
    projeto: 'projeto anotado',
    evento: 'data importante salva',
    agenda: 'compromisso na agenda',
    rotina: 'rotina atualizada',
    preferencia: 'preferência registrada',
  };
  const found = contexts.filter(c => labels[c]).map(c => labels[c]);
  if (found.length === 0) return '';
  if (found.length === 1) return found[0];
  return found.slice(0, -1).join(', ') + ' e ' + found[found.length - 1];
}

// ============================================================
// HELPER: parse seguro de JSON — tenta reparar truncamentos
// ============================================================
export function safeParseJSON(raw: string): any | null {
  const clean = raw.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    let fixed = clean;
    // Remove propriedade truncada no meio de string
    fixed = fixed.replace(/,?\s*"[^"]*":\s*"[^"]*$/, '');
    fixed = fixed.replace(/,?\s*"[^"]*":\s*$/, '');
    // Fecha string aberta
    if ((fixed.match(/"/g) || []).length % 2 !== 0) fixed += '"';
    // Fecha arrays e objetos
    const opens = (fixed.match(/\{/g) || []).length;
    const closes = (fixed.match(/\}/g) || []).length;
    const aOpens = (fixed.match(/\[/g) || []).length;
    const aCloses = (fixed.match(/\]/g) || []).length;
    for (let i = 0; i < aOpens - aCloses; i++) fixed += ']';
    for (let i = 0; i < opens - closes; i++) fixed += '}';
    try {
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
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
  "aniversário de casamento é dia 13 de dezembro" → evento
  "todo natal a gente se reúne" → evento
  "páscoa em família todo ano" → evento
  "meu aniversário é dia 27 de setembro" → evento + perfil
- "agenda": compromissos com data E hora específica (consulta, reunião, voo)
- "rotina": horários fixos, hábitos diários, lembretes recorrentes
- "preferencia": gostos, lugares favoritos, comidas, hobbies, opiniões
- "recomendacao": lugares, produtos, serviços ou pessoas recomendados ou elogiados
  "fui no X e adorei", "meu amigo indicou o restaurante Y", "o app Z é ótimo"
  Também captura quando o assistente sugere algo e o usuário demonstra interesse
- "relacao": dinâmica ou sentimento sobre pessoa específica — ex parceiro, familiar distante, colega
  "não nos damos bem", "relação difícil", "a gente não se fala", "me dou bem com"

REGRAS:
- Analise APENAS o que o USUÁRIO afirma — ignore perguntas ou afirmações do assistente
- has_new_facts: true se QUALQUER fato pessoal for afirmado — incluindo dinâmicas relacionais
- has_new_facts: false APENAS para saudações, piadas, perguntas genéricas sem info pessoal
- Se gaps indicarem campo pendente e usuário responder → inclua o contexto correto
- "sim" ou "não" como resposta a gap → inclua o contexto do gap

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

  const [profileRes, childrenRes] = await Promise.all([
    supabase.from('user_profiles')
      .select(`full_name, preferred_name, spouse_name, city, current_job,
               father_name, mother_name, profession, phone, whatsapp,
               birth_date, birth_city, education_level, faith_profile,
               siblings_count, gender`)
      .eq('user_id', userId).maybeSingle(),
    supabase.from('children').select('name').eq('parent_id', userId),
  ]);

  const p = profileRes.data;
  const childNames = (childrenRes.data || []).map((c: any) => c.name);

  const prompt = `Identifique lacunas de informação. Máximo 2 gaps relevantes.

Mensagem do usuário: "${userMessage}"

O que JÁ SABEMOS (não pergunte o que já está preenchido):
- Nome completo: ${p?.full_name || 'desconhecido'}
- Como prefere ser chamado: ${p?.preferred_name || 'não informado'}
- Gênero: ${p?.gender || 'desconhecido'}
- Cônjuge: ${p?.spouse_name || 'desconhecido'}${(p as any)?.spouse_birthday ? ` (aniversário: ${(p as any).spouse_birthday})` : ''}
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

Campos válidos para gaps (APENAS dados pessoais e família):
nome_completo, nome_esposa, nome_marido, nome_filho, nome_pai, nome_mae,
data_nascimento_filho, data_nascimento_esposa

NUNCA crie gap para: nome_projeto, tema_evento, data_evento, nome_medico
Esses dados chegam quando o usuário quiser informar — não pergunte.

Retorne APENAS JSON:
{"gaps": [{"field": "nome_esposa", "context": "cônjuge mencionado sem nome", "hint": "E como ela se chama?", "urgencia": "alta"}]}
urgencia: "alta"|"media"|"baixa"
Retorne {"gaps": []} se não há lacunas ou se já sabemos tudo.`;

  try {
    const data = JSON.parse(await callAI(prompt, 300));
    const validContexts = ['perfil', 'familia'];
    if (!contexts.some(c => validContexts.includes(c))) return [];
    return (data.gaps || []).filter((g: DetectedGap) => g.urgencia !== 'baixa');
  } catch { return []; }
}

// ============================================================
// EXTRATOR: PERFIL COMPLETO
// ============================================================

async function extractPerfil(userId: string, userMessage: string): Promise<void> {
  // 1. Busca dados atuais de ambas as tabelas para evitar sobrescrita cega
  const { data: userCurrent } = await supabase
    .from('users')
    .select('preferred_name, nickname')
    .eq('id', userId).single();

  const { data: profileCurrent } = await supabase
    .from('user_profiles')
    .select('full_name, gender, schools, birth_date, birth_city, birth_state, phone, whatsapp, father_name, mother_name, faith_profile, profession, company')
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
- FONTE: extraia APENAS do que o USUÁRIO afirma.
- nome_completo: só com sobrenome(s). "Celio Roberto" → ignorar. "Celio Roberto Ramos do Nascimento" → extrai.
- nome_preferido: "pode me chamar de X", "me chama de X".
- escolaridade: "fundamental"|"medio"|"tecnico"|"superior_cursando"|"superior_completo"|"pos_graduacao"|"mestrado"|"doutorado"
- fe: "christian_declared"|"open"|"none"
- nascimento: YYYY-MM-DD`;

  try {
    const data = JSON.parse(await callAI(prompt, 400));
    const userPatch: Record<string, any> = {};
    const profilePatch: Record<string, any> = {};

    // Helper para decidir o que atualizar
    function setField(target: 'user' | 'profile', field: string, newVal: any, type: 'name' | 'once' | 'array' | 'number' = 'once') {
      if (newVal === null || newVal === undefined || newVal === '') return;

      const currentObj = target === 'user' ? userCurrent : profileCurrent;
      const patchObj = target === 'user' ? userPatch : profilePatch;
      const cur = (currentObj as any)?.[field];

      if (type === 'name') {
        const curWords = cur ? cur.trim().split(/\s+/).length : 0;
        const newWords = String(newVal).trim().split(/\s+/).length;
        if (!cur || newWords > curWords) patchObj[field] = newVal;
      } else if (type === 'array') {
        const existing = cur || [];
        if (!existing.includes(newVal)) patchObj[field] = [...existing, newVal];
      } else if (type === 'number') {
        if (cur === null || cur === undefined) patchObj[field] = newVal;
      } else {
        if (!cur) patchObj[field] = newVal;
      }
    }

    // Mapeamento para jarvis.users
    setField('user', 'preferred_name', data.nome_preferido);
    setField('user', 'nickname', data.apelido);

    // Mapeamento para jarvis.user_profiles
    setField('profile', 'full_name', data.nome_completo, 'name');
    setField('profile', 'city', data.cidade);
    setField('profile', 'state', data.estado);
    setField('profile', 'birth_city', data.cidade_natal);
    setField('profile', 'birth_state', data.estado_natal);
    setField('profile', 'birth_date', data.nascimento);
    setField('profile', 'phone', data.telefone);
    setField('profile', 'whatsapp', data.whatsapp);
    setField('profile', 'father_name', data.nome_pai, 'name');
    setField('profile', 'mother_name', data.nome_mae, 'name');
    setField('profile', 'faith_profile', data.fe);
    setField('profile', 'faith_notes', data.fe_notas);
    setField('profile', 'profession', data.formacao);
    setField('profile', 'current_job', data.cargo_atual);
    setField('profile', 'company', data.empresa);
    setField('profile', 'job_start_date', data.data_inicio_emprego);
    setField('profile', 'schools', data.escola, 'array');

    if (data.qtd_irmaos !== null) setField('profile', 'siblings_count', parseInt(data.qtd_irmaos), 'number');

    // 1. Atualiza Identidade de Sistema (Users)
    if (Object.keys(userPatch).length > 0) {
      await supabase.from('users').update(userPatch).eq('id', userId);
      console.log('[Extrator/Perfil] Users atualizado:', Object.keys(userPatch));
    }

    // 2. Atualiza Dados Biográficos (Profiles)
    if (Object.keys(profilePatch).length > 0) {
      profilePatch.user_id = userId;
      profilePatch.updated_at = new Date().toISOString();
      await supabase.from('user_profiles').upsert(profilePatch, { onConflict: 'user_id' });
      console.log('[Extrator/Perfil] Profile atualizado:', Object.keys(profilePatch));
    }

  } catch (e) { console.error('[Extrator/Perfil] Erro crítico:', e); }
}

// ============================================================
// EXTRATOR: FAMÍLIA
// ============================================================

async function extractFamilia(
  userId: string,
  userMessage: string,
  gaps: DetectedGap[]
): Promise<void> {
  const hasEsposaGap = gaps.some(g => g.field === 'nome_esposa' || g.field === 'nome_marido');
  const hasFilhoGap = gaps.some(g => g.field === 'nome_filho');

  const { data: current } = await supabase
    .from('user_profiles')
    .select('spouse_name, spouse_birthday, father_name, mother_name')
    .eq('user_id', userId).maybeSingle();

  const prompt = `Extraia dados familiares afirmados explicitamente pelo USUÁRIO.
IGNORE qualquer informação vinda de perguntas ou afirmações do assistente.
${hasEsposaGap ? 'PRIORIDADE: usuário fornecendo nome do cônjuge — extraia.' : ''}
${hasFilhoGap ? 'PRIORIDADE: usuário fornecendo nome de filho — extraia.' : ''}

Mensagem do usuário: "${userMessage}"

Retorne APENAS JSON (null para não mencionados):
{
  "esposa":  {"nome": null, "aniversario": null, "telefone": null, "apelido": null, "nota": null},
  "marido":  {"nome": null, "aniversario": null, "telefone": null, "apelido": null, "nota": null},
  "filhos": [{"nome": null, "nascimento": null, "idade": null, "genero": null, "pronome": null, "escola": null, "serie": null, "turno": null, "nivel_escolar": null, "necessidades_especiais": null, "autonomia": null, "apelido": null, "outro_pai": null, "nota": null}],
  "pai":    {"nome": null, "apelido": null},
  "mae":    {"nome": null, "apelido": null}
}

REGRAS:
- filhos: [] se nenhum mencionado
- nascimento: data de nascimento DO PRÓPRIO USUÁRIO. Formato YYYY-MM-DD.
  "nasci em 27/09/1985" → nascimento="1985-09-27"
  "meu aniversário é dia 27 de setembro" → nascimento="1985-09-27" (se ano conhecido)
  "aniversário de casamento é dia 13 de dezembro" → nascimento=null (não é nascimento!)
  "aniversário da Giselle é dia 5 de agosto" → nascimento=null (é de outra pessoa!)
  NUNCA extraia nascimento de aniversários de casamento ou de terceiros
- aniversario: DD/MM, YYYY-MM-DD, ou "5 de agosto"
- genero: "m"|"f"|null — extraia de "ele"/"ela", "meu filho"/"minha filha", ou declaração explícita
- pronome: "ele"|"ela"|null — pronome usado na mensagem para referir ao filho
- apelido: como o usuário chama a pessoa ("vida", "velho", "mãezinha")
- nota (esposa/marido): fato marcante mencionado sobre o cônjuge
  "a Giselle comprou um carro" → nota="Comprou um carro" | null se nenhum
- serie: série/ano escolar exato ("P5", "1º ano", "3º médio") ou tipo ("creche", "maternal")
- nivel_escolar: "creche"|"pre"|"fundamental"|"medio"|"superior"|"nao_estuda" — infira do contexto
  "creche" → nivel_escolar="creche" | "P5" → nivel_escolar="pre" | "ensino médio concluído" → nivel_escolar="nao_estuda"
- turno: "manha"|"tarde"|"integral"|"noite"|null
- necessidades_especiais: array de strings se mencionado, ex: ["autismo", "TDAH"] | null se não mencionado
- autonomia: 1-5 se frase indicar grau de independência, null se não mencionado
  "não faz nada sozinho" → 1 | "precisa de ajuda" → 2 | "se vira em algumas coisas" → 3
  "bastante independente" → 4 | "totalmente independente / se vira sozinho" → 5
- outro_pai: nome do outro pai/mãe biológico SE mencionado
  "a mãe do Davi é Giselle" → outro_pai="Giselle"
  "é de um casamento anterior" → outro_pai="desconhecido"
  "filho da Ana" → outro_pai="Ana"
  null se não mencionado
- nota: fato marcante OU dinâmica relacional mencionada sobre a criança
  "o Pedro comprou uma moto" → nota="Comprou uma moto"
  "não nos damos bem, relação difícil" (sobre Pedro) → nota="Relação difícil com o pai"
  "o Davi ganhou mochila do Pikachu" → nota="Ganhou mochila do Pikachu"
  null se nenhum fato ou dinâmica mencionada`;

  try {
    const { data: existingKids } = await supabase.from('children')
      .select('id').eq('parent_id', userId);
    const kidCount = Math.max((existingKids || []).length, 1);
    const maxTokens = 300 + (kidCount * 100);

    const raw = await callAI(prompt, maxTokens);
    const data = safeParseJSON(raw);
    if (!data) { console.error('[Extrator/familia] JSON inválido:', raw.slice(0, 200)); return; }

    // ── Cônjuge ──────────────────────────────────────────────
    const conjuge = data.esposa?.nome ? data.esposa : data.marido?.nome ? data.marido : null;
    if (conjuge?.nome) {
      const patch: Record<string, any> = { user_id: userId, updated_at: new Date().toISOString() };
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
      await upsertPerson(userId, conjuge.nome, 'spouse', {
        noteText: conjuge.nota ?? undefined,
      });
      console.log('[Extrator/familia] Cônjuge:', conjuge.nome);
    }

    // ── Filhos ───────────────────────────────────────────────
    for (const filho of (data.filhos || [])) {
      if (!filho.nome) continue;

      const firstName = filho.nome.split(' ')[0].toLowerCase();

      const { data: allChildren } = await supabase.from('children')
        .select('id, name, birth_date, nickname, child_user_id')
        .eq('parent_id', userId);

      const ex = (allChildren || []).find((c: any) =>
        c.name.split(' ')[0].toLowerCase() === firstName
      ) || null;

      let birth_date: string | null = null;
      if (filho.nascimento) {
        birth_date = normalizeDate(filho.nascimento);
      } else if (filho.idade) {
        birth_date = `${new Date().getFullYear() - filho.idade}-01-01`;
      }

      const ageReal = birth_date
        ? Math.floor((Date.now() - new Date(birth_date).getTime()) / (1000 * 60 * 60 * 24 * 365.25))
        : filho.idade;
      const life_phase = getLifePhase(ageReal);

      const existingName = ex?.name || '';
      const existingWords = existingName.trim().split(/\s+/).length;
      const newWords = filho.nome.trim().split(/\s+/).length;
      const nameToSave = (!existingName || newWords > existingWords) ? filho.nome : existingName;

      let nicknameToSave: string | null = ex?.nickname || null;
      if (ex?.child_user_id) {
        const { data: childUser } = await supabase
          .from('user_profiles').select('preferred_name, full_name')
          .eq('user_id', String(ex.child_user_id)).maybeSingle();
        nicknameToSave = childUser?.preferred_name || childUser?.full_name?.split(' ')[0] || null;
      } else {
        const apelido = filho.apelido || nameToSave.split(' ')[0];
        const apWords = apelido.trim().split(/\s+/).length;
        const curWords = (ex?.nickname || '').trim().split(/\s+/).length;
        if (!ex?.nickname || apWords > curWords) nicknameToSave = apelido;
      }

      let generoNorm: string | null = null;
      if (filho.genero) {
        const g = filho.genero.toLowerCase();
        generoNorm = (g === 'm' || g.startsWith('masc')) ? 'masculino'
          : (g === 'f' || g.startsWith('fem')) ? 'feminino' : 'outro';
      } else if (filho.pronome) {
        generoNorm = filho.pronome === 'ele' ? 'masculino' : filho.pronome === 'ela' ? 'feminino' : null;
      }

      const childData: Record<string, any> = {
        name: nameToSave,
        updated_at: new Date().toISOString(),
      };
      if (birth_date) childData.birth_date = birth_date;
      if (life_phase && (!ex || birth_date)) childData.life_phase = life_phase;
      if (nicknameToSave) childData.nickname = nicknameToSave;
      if (generoNorm) childData.gender = generoNorm;
      if (filho.escola) childData.school_name = filho.escola;
      if (filho.serie) childData.school_grade = filho.serie;
      if (filho.turno) childData.school_shift = filho.turno;
      if (filho.necessidades_especiais) childData.special_needs = filho.necessidades_especiais;
      if (filho.outro_pai) childData.other_parent_name = filho.outro_pai === 'desconhecido' ? null : filho.outro_pai;

      if (filho.nota) {
        const { data: childRec } = await supabase.from('children')
          .select('lev_notes').eq('id', ex?.id || '').maybeSingle();
        const existing = childRec?.lev_notes || '';
        const newNote = `[${new Date().toLocaleDateString('pt-BR')}] ${filho.nota}`;
        if (!existing.includes(filho.nota)) {
          childData.lev_notes = existing ? `${existing}\n${newNote}` : newNote;
        }
      }

      const autonomyByPhase: Record<string, number> = {
        baby: 1, child: 2, teen: 3, young_adult: 4, adult: 5,
      };
      if (filho.autonomia) {
        childData.autonomy_level = Math.min(5, Math.max(1, parseInt(String(filho.autonomia))));
      } else if (!ex) {
        childData.autonomy_level = autonomyByPhase[life_phase] || 2;
      }

      if (filho.nivel_escolar) {
        if (!birth_date && !ex?.birth_date) {
          const nivelToPhase: Record<string, string> = {
            creche: 'baby', pre: 'child', fundamental: 'child',
            medio: 'teen', superior: 'young_adult',
          };
          if (nivelToPhase[filho.nivel_escolar]) childData.life_phase = nivelToPhase[filho.nivel_escolar];
        }
        if (!filho.serie && ['creche', 'pre'].includes(filho.nivel_escolar)) {
          childData.school_grade = filho.nivel_escolar;
        }
        if (filho.nivel_escolar === 'nao_estuda') {
          childData.school_name = null;
          childData.school_grade = null;
          const nivelLabel: Record<string, string> = {
            medio: 'Ensino médio concluído',
            superior: 'Ensino superior concluído',
            fundamental: 'Ensino fundamental concluído',
          };
          const nivelConcluido = filho.serie
            ? `${filho.serie} concluído`
            : nivelLabel[filho.serie || ''] || 'Ensino médio concluído';
          const { data: childRec } = await supabase.from('children')
            .select('lev_notes').eq('id', ex?.id || '').maybeSingle();
          const existingNotes = childRec?.lev_notes || '';
          if (!existingNotes.includes('concluído')) {
            const noteDate = new Date().toLocaleDateString('pt-BR');
            childData.lev_notes = existingNotes
              ? `${existingNotes}\n[${noteDate}] ${nivelConcluido}`
              : `[${noteDate}] ${nivelConcluido}`;
          }
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
      await upsertPerson(userId, nameToSave, 'child', {
        nickname: nicknameToSave ?? undefined,
      });
      console.log('[Extrator/familia] Filho:', nameToSave, ex ? '(atualizado)' : '(novo)');
    }

    // ── Pai ──────────────────────────────────────────────────
    if (data.pai?.nome && !current?.father_name) {
      await supabase.from('user_profiles').upsert(
        { user_id: userId, father_name: data.pai.nome, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
      if (data.pai.apelido) await upsertAlias(userId, data.pai.apelido, 'parent', null, data.pai.nome);
      await upsertPerson(userId, data.pai.nome, 'parent', { nickname: data.pai.apelido ?? undefined });
      console.log('[Extrator/familia] Pai:', data.pai.nome);
    }

    // ── Mãe ──────────────────────────────────────────────────
    if (data.mae?.nome && !current?.mother_name) {
      await supabase.from('user_profiles').upsert(
        { user_id: userId, mother_name: data.mae.nome, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
      if (data.mae.apelido) await upsertAlias(userId, data.mae.apelido, 'parent', null, data.mae.nome);
      await upsertPerson(userId, data.mae.nome, 'parent', { nickname: data.mae.apelido ?? undefined });
      console.log('[Extrator/familia] Mãe:', data.mae.nome);
    }

  } catch (e) { console.error('[Extrator/familia] Erro:', e); }
}

// ============================================================
// UPSERT PERSON
// ============================================================

const INITIAL_WEIGHTS: Record<string, number> = {
  spouse: 1.0,
  child: 0.9,
  parent: 0.7,
  sibling: 0.4,
  friend: 0.3,
  colleague: 0.2,
  ex: 0.1,
  other: 0.1,
};

async function upsertPerson(
  userId: string,
  name: string,
  type: string,
  options?: { nickname?: string; weightDelta?: number; noteText?: string }
): Promise<string | null> {
  try {
    const baseWeight = INITIAL_WEIGHTS[type] ?? 0.1;

    const { data: existing } = await supabase
      .from('persons')
      .select('id, emotional_weight, nickname')
      .eq('user_id', userId)
      .eq('name', name)
      .eq('type', type)
      .maybeSingle();

    let personId: string;

    if (existing) {
      const delta = options?.weightDelta ?? 0.02;
      const newWeight = Math.min(1.0, existing.emotional_weight + delta);
      await supabase.from('persons').update({
        emotional_weight: newWeight,
        last_mentioned: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...(options?.nickname && !existing.nickname ? { nickname: options.nickname } : {}),
      }).eq('id', existing.id);
      personId = existing.id;
    } else {
      const { data: created } = await supabase.from('persons').insert({
        user_id: userId,
        name,
        type,
        emotional_weight: baseWeight,
        nickname: options?.nickname ?? null,
        last_mentioned: new Date().toISOString(),
      }).select('id').single();
      personId = created?.id;
    }

    if (options?.noteText && personId) {
      await supabase.from('person_notes').upsert({
        user_id: userId,
        person_name: name,
        person_type: type,
        person_id: personId,
        note: options.noteText,
        noted_at: new Date().toISOString().slice(0, 10),
      }, { onConflict: 'user_id,person_name,note,noted_at', ignoreDuplicates: true });
    }

    console.log(`[upsertPerson] ${name} (${type})`);
    return personId ?? null;
  } catch (e) {
    console.error('[upsertPerson] Erro:', e);
    return null;
  }
}

// ============================================================
// EXTRATOR: RELAÇÕES / DINÂMICAS
// ============================================================

async function extractRelacao(userId: string, userMessage: string): Promise<void> {
  const { data: prof } = await supabase
    .from('user_profiles').select('spouse_name, father_name, mother_name').eq('user_id', userId).maybeSingle();
  const { data: kids } = await supabase.from('children').select('name, nickname, other_parent_name').eq('parent_id', userId);

  const conhecidos = [
    prof?.spouse_name ? `cônjuge: ${prof.spouse_name}` : null,
    prof?.father_name ? `pai: ${prof.father_name}` : null,
    prof?.mother_name ? `mãe: ${prof.mother_name}` : null,
    ...(kids || []).flatMap((k: any) => [
      `filho: ${k.name}`,
      k.other_parent_name ? `mãe/pai de ${k.name}: ${k.other_parent_name}` : null,
    ]),
  ].filter(Boolean).join(', ');

  const prompt = `Extraia dinâmicas relacionais afirmadas pelo USUÁRIO sobre pessoas específicas.

Mensagem do usuário: "${userMessage}"

Pessoas já conhecidas (USE para determinar o tipo correto):
${conhecidos || 'nenhuma ainda'}

REGRA CRÍTICA para determinar o tipo:
- Se a pessoa é identificada como "mãe de [filho]" ou "pai de [filho]" → tipo="ex" (outro pai/mãe do filho)
- Se a pessoa É o cônjuge listado em "cônjuge:" acima → tipo="spouse"
- Se for parente (irmão, tio, avô) → tipo="family"
- Nunca assuma que uma pessoa nova é cônjuge — só se estiver na lista acima como cônjuge

Retorne APENAS JSON:
{"relacoes": [{"pessoa": "Adriana", "tipo": "ex", "dinamica": "Relação difícil, não se dão bem"}]}

tipos: spouse|ex|friend|colleague|family|other
dinamica: resumo objetivo em 1 frase
Retorne relacoes: [] se nenhuma dinâmica mencionada`;

  try {
    const raw = await callAI(prompt, 300);
    const data = safeParseJSON(raw);
    if (!data) { console.error('[Extrator/relacao] JSON inválido:', raw.slice(0, 100)); return; }
    for (const r of (data.relacoes || [])) {
      if (!r.pessoa || !r.dinamica) continue;
      await upsertPerson(userId, r.pessoa, r.tipo || 'other', {
        noteText: r.dinamica,
      });
      console.log('[Extrator/relacao]', r.pessoa, '→', r.dinamica);
    }
  } catch (e) { console.error('[Extrator/relacao] Erro:', e); }
}

async function extractAlias(userId: string, userMessage: string): Promise<void> {
  // Busca o contexto de quem o Jarvis já conhece no seu perfil
  const { data: prof } = await supabase
    .from('user_profiles')
    .select('spouse_name, father_name, mother_name')
    .eq('user_id', userId).maybeSingle();
    
  const { data: kids } = await supabase
    .from('children')
    .select('name')
    .eq('parent_id', userId);

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

Tipos aceitos: spouse|child|parent|sibling|friend|other`;

  try {
    const aiResponse = await callAI(prompt, 200);
    const data = JSON.parse(aiResponse);
    
    for (const a of (data.aliases || [])) {
      if (!a.apelido) continue;
      // Chama sua função auxiliar de upsert para gravar o alias
      await upsertAlias(userId, a.apelido, a.tipo || 'other', null, a.nome_real || null);
      console.log('[Extrator/Alias] Novo apelido:', a.apelido, 'para', a.nome_real || 'desconhecido');
    }
  } catch (e) { console.error('[Extrator/Alias] Erro ao extrair:', e); }
}