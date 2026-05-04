// ============================================================
// lib/extractor.ts
// Arquitetura Modular (Zero-Waste) - Padrão Registry
// ============================================================

import { createClient } from '@supabase/supabase-js';
import {
  extractProjeto, extractEvento, extractAgenda,
  extractRotina, extractPreferencia, extractRecomendacao, updateL3,
  callAI, upsertAlias, upsertEvent, normalizeDate,
  getCategoryFromType, getLifePhase, extractShopping
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
// REGISTRO DE MÓDULOS (O Coração Desacoplado)
// Para adicionar novos módulos (ex: Frota), basta adicionar aqui!
// ============================================================

const EXTRACTION_MODULES = [
  {
    id: 'perfil',
    promptDesc: 'nome completo, nome preferido, apelido pessoal, cidade/estado atual ou natal, data de nascimento, gênero, telefone, whatsapp, nome do pai, nome da mãe, quantidade de irmãos, fé/religião, formação acadêmica (curso/área), cargo/emprego atual ou futuro, empresa, data início emprego, escola/faculdade cursada',
    match: (ctx: string[], msg: string) => ctx.includes('perfil'),
    run: (userId: string, msg: string, aiReply: string, gaps: DetectedGap[]) => extractPerfil(userId, msg)
  },
  {
    id: 'familia',
    promptDesc: 'esposa/marido (nome, aniversário, telefone), filhos (nome, idade, escola, série, turno, creche, ensino médio, necessidades especiais), nome da mãe/pai de um filho específico',
    match: (ctx: string[], msg: string) => ctx.includes('familia') && /filho|filha|esposa|marido|cônjuge|pai|mãe|irmão|irmã|bebê|criança|nasceu|grávid/i.test(msg),
    run: (userId: string, msg: string, aiReply: string, gaps: DetectedGap[]) => extractFamilia(userId, msg, gaps)
  },
  {
    id: 'alias',
    promptDesc: 'apelido que o usuário usa para chamar alguém ("vida"=esposa, "velho"=pai)',
    match: (ctx: string[], msg: string) => ctx.includes('alias') && /chamo|chama|apelido|me chama de|chamo de/i.test(msg),
    run: (userId: string, msg: string, aiReply: string, gaps: DetectedGap[]) => extractAlias(userId, msg)
  },
  {
    id: 'projeto',
    promptDesc: 'projetos, ideias, apps, negócios que desenvolve ou quer desenvolver',
    match: (ctx: string[], msg: string) => ctx.includes('projeto') && /projeto|app|sistema|negócio|ideia|desenvolv|startup|pqf/i.test(msg),
    run: (userId: string, msg: string, aiReply: string, gaps: DetectedGap[]) => extractProjeto(userId, msg)
  },
  {
    id: 'evento',
    promptDesc: 'aniversários, festas, datas comemorativas recorrentes (sem hora específica). Ex: "todo natal a gente se reúne", "meu aniversário é dia 27 de setembro"',
    match: (ctx: string[], msg: string) => ctx.includes('evento'),
    run: (userId: string, msg: string, aiReply: string, gaps: DetectedGap[]) => extractEvento(userId, msg)
  },
  {
    id: 'agenda',
    promptDesc: 'compromissos com data E hora específica (consulta, reunião, voo)',
    match: (ctx: string[], msg: string) => ctx.includes('agenda') && /\d{1,2}[\/\-:h]\d|às \d|amanhã|semana que vem|consulta|reunião|voo|compromisso/i.test(msg),
    run: (userId: string, msg: string, aiReply: string, gaps: DetectedGap[]) => extractAgenda(userId, msg)
  },
  {
    id: 'rotina',
    promptDesc: 'horários fixos, hábitos diários, lembretes recorrentes',
    match: (ctx: string[], msg: string) => ctx.includes('rotina') && /todo dia|toda manhã|sempre|rotina|hábito|costume|horário|acord|dorm/i.test(msg),
    run: (userId: string, msg: string, aiReply: string, gaps: DetectedGap[]) => extractRotina(userId, msg)
  },
  {
    id: 'preferencia',
    promptDesc: 'gostos, lugares favoritos, comidas, hobbies, opiniões',
    match: (ctx: string[], msg: string) => ctx.includes('preferencia'),
    run: (userId: string, msg: string, aiReply: string, gaps: DetectedGap[]) => extractPreferencia(userId, msg)
  },
  {
    id: 'relacao',
    promptDesc: 'dinâmica ou sentimento sobre pessoa específica — ex parceiro, familiar distante, colega',
    match: (ctx: string[], msg: string) => ctx.includes('relacao') && /não (nos|me|se) (damos|dou|fala)|relação|difícil|distante|próximo|me dou bem/i.test(msg),
    run: (userId: string, msg: string, aiReply: string, gaps: DetectedGap[]) => extractRelacao(userId, msg)
  },
  {
    id: 'recomendacao',
    promptDesc: 'lugares, produtos, serviços ou pessoas recomendados ou elogiados. Ex: "fui no X e adorei"',
    match: (ctx: string[], msg: string) => ctx.includes('recomendacao'),
    run: (userId: string, msg: string, aiReply: string, gaps: DetectedGap[]) => extractRecomendacao(userId, msg, aiReply)
  },
  {
    id: 'compras',
    promptDesc: 'anotação de itens de mercado, farmácia, materiais de reforma',
    match: (ctx: string[], msg: string) => ctx.includes('compras') || /comprar|anota|lista|falta|acabou|mercado|reforma|academia/i.test(msg),
    run: (userId: string, msg: string, aiReply: string, gaps: DetectedGap[]) => extractShopping(userId, msg, aiReply) // Passando aiReply!
  }
];

// ============================================================
// GUARD
// ============================================================

function assertNumericUserId(userId: string, caller: string): void {
  if (!/^\d+$/.test(userId)) {
    throw new Error(`[${caller}] FATAL: userId não é bigint numérico — recebeu: "${userId}".`);
  }
}

// ============================================================
// BLOCO DE GAPS PARA O PROMPT DO WEBHOOK
// ============================================================

export async function buildGapsBlock(userId: string, currentMessage?: string): Promise<string> {
  assertNumericUserId(userId, 'buildGapsBlock');
  try {
    const { data } = await supabase.from('users').select('pending_gaps').eq('id', userId).single();
    const gaps: DetectedGap[] = data?.pending_gaps || [];
    if (gaps.length === 0) return '';

    const msgLower = (currentMessage || '').toLowerCase();
    const isEmotional = /dific|barra|trist|saudade|relação|família|filho|esposa|mãe|pai|deus|fé|oração/.test(msgLower);
    const isAboutDate = /aniversário|data|nascimento|casamento|páscoa|natal/.test(msgLower);
    const isAboutWork = /trabalho|projeto|empresa|reunião|entrega|prazo|cliente/.test(msgLower);
    const hasProjectGap = gaps.some(g => (g.field || '').match(/projeto|pqf/i));
    const blockProjectGap = hasProjectGap && !isAboutWork;

    const temAberturaReal = !isEmotional && !isAboutDate && !blockProjectGap;
    if (!temAberturaReal) return '';

    const lines = gaps.map(g => `- [${(g.urgencia || 'media').toUpperCase()}] ${g.context}\n  → ${g.hint}`).join('\n');

    return [
      '[LEMBRETE INTERNO — pergunte apenas se cair naturalmente na conversa]',
      lines,
      'Faça UMA pergunta, de forma leve, apenas se o assunto já estiver próximo.',
    ].join('\n');
  } catch { return ''; }
}

// ============================================================
// EXTRAÇÃO COM RESUMO (Orquestrador Dinâmico)
// ============================================================

export async function extractAndSummarize(
  maybeUuid: string,
  userName: string,
  userMessage: string,
  aiReply: string = ''
): Promise<string> {
  let userId = maybeUuid;

  if (maybeUuid.includes('-')) {
    const { data: userData } = await supabase.from('users').select('id').eq('auth_user_id', maybeUuid).maybeSingle();
    if (userData) {
      userId = String(userData.id);
    } else {
      console.error(`[Extrator] Erro crítico: Usuário UUID ${maybeUuid} não encontrado.`);
      return '';
    }
  }

  assertNumericUserId(userId, 'extractAndSummarize');

  try {
    const { data: userData } = await supabase.from('users').select('pending_gaps').eq('id', userId).single();
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

    // ── O NOVO ROTEADOR BLINDADO ──
    console.log('[Extrator/classify] contextos:', classification.contexts);
    const tasks: Promise<void>[] = [];

    for (const module of EXTRACTION_MODULES) {
      if (module.match(classification.contexts, userMessage)) {
        tasks.push(module.run(userId, userMessage, aiReply, pendingGaps));
      }
    }

    console.log('[Extrator/tasks]', tasks.length, 'tarefas ativas');

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

export async function extractAndRoute(userId: string, userName: string, userMessage: string, aiReply: string): Promise<void> {
  await extractAndSummarize(userId, userName, userMessage, aiReply);
}

function summarizeContexts(contexts: string[]): string {
  const labels: Record<string, string> = {
    perfil: 'dados do seu perfil', familia: 'informações da sua família',
    alias: 'apelido registrado', projeto: 'projeto anotado',
    evento: 'data importante salva', agenda: 'compromisso na agenda',
    rotina: 'rotina atualizada', preferencia: 'preferência registrada',
    compras: 'lista de compras atualizada',
  };
  const found = contexts.filter(c => labels[c]).map(c => labels[c]);
  if (found.length === 0) return '';
  if (found.length === 1) return found[0];
  return found.slice(0, -1).join(', ') + ' e ' + found[found.length - 1];
}

export function safeParseJSON(raw: string): any | null {
  const clean = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch {
    let fixed = clean.replace(/,?\s*"[^"]*":\s*"[^"]*$/, '').replace(/,?\s*"[^"]*":\s*$/, '');
    if ((fixed.match(/"/g) || []).length % 2 !== 0) fixed += '"';
    const opens = (fixed.match(/\{/g) || []).length;
    const closes = (fixed.match(/\}/g) || []).length;
    const aOpens = (fixed.match(/\[/g) || []).length;
    const aCloses = (fixed.match(/\]/g) || []).length;
    for (let i = 0; i < aOpens - aCloses; i++) fixed += ']';
    for (let i = 0; i < opens - closes; i++) fixed += '}';
    try { return JSON.parse(fixed); } catch { return null; }
  }
}

// ============================================================
// CLASSIFICADOR (Agora Monta Dinamicamente!)
// ============================================================

async function classify(userMessage: string, gapsCtx: string): Promise<Classification> {
  // O prompt agora lê as descrições de EXTRACTION_MODULES automaticamente
  const descricoes = EXTRACTION_MODULES.map(m => `- "${m.id}": ${m.promptDesc}`).join('\n');

  const prompt = `Analise a mensagem e identifique contextos com FATOS NOVOS sobre o usuário.

Mensagem do usuário: "${userMessage}"
${gapsCtx ? `\n${gapsCtx}` : ''}

Contextos disponíveis:
${descricoes}

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
// DETECTOR DE GAPS (Mantido intacto para estabilidade)
// ============================================================

async function detectGaps(userId: string, userMessage: string, contexts: string[], existingGaps: DetectedGap[]): Promise<DetectedGap[]> {
  if (contexts.length === 0) return [];

  const [profileRes, childrenRes] = await Promise.all([
    supabase.from('user_profiles').select(`full_name, preferred_name, spouse_name, city, current_job, father_name, mother_name, profession, phone, whatsapp, birth_date, birth_city, education_level, faith_profile, siblings_count, gender`).eq('user_id', userId).maybeSingle(),
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

NUNCA crie gap para: nome_projeto, tema_evento, data_evento, nome_medico.

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
