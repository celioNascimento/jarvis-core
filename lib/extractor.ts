// ============================================================
// lib/extractor.ts
// Extrator Contínuo — Brain como Fonte da Verdade
//
// FLUXO:
//   Mensagem → Classificador (com contexto de gaps) → Extratores em paralelo
//   → user_profiles | children | projects | events | agenda
//   → L3 (current_context) atualizado
//
// Chamado pelo webhook após brain.insert, com await.
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
      // Limpa gaps resolvidos
      await supabase.from('users').update({ pending_gaps: [] }).eq('id', userId);
    }

    // Estágio 3: Extratores em paralelo
    const tasks: Promise<void>[] = [];

    if (classification.contexts.includes('perfil'))     tasks.push(extractPerfil(userId, userMessage, aiReply));
    if (classification.contexts.includes('familia'))    tasks.push(extractFamilia(userId, userMessage, aiReply, pendingGaps));
    if (classification.contexts.includes('projeto'))    tasks.push(extractProjeto(userId, userMessage, aiReply));
    if (classification.contexts.includes('evento'))     tasks.push(extractEvento(userId, userMessage, aiReply));
    if (classification.contexts.includes('agenda'))     tasks.push(extractAgenda(userId, userMessage, aiReply));
    if (classification.contexts.includes('rotina'))     tasks.push(extractRotina(userId, userMessage, aiReply));
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
// ============================================================

async function classify(
  userMessage: string,
  aiReply: string,
  gapsCtx: string
): Promise<Classification> {
  const prompt = `Analise a troca e identifique contextos com FATOS NOVOS.

Usuário: "${userMessage}"
Assistente: "${aiReply}"
${gapsCtx ? `\n${gapsCtx}` : ''}

Contextos:
- perfil: cidade, profissão, nascimento, empresa
- familia: esposa/marido (nome, aniversário), filhos (nome, idade)
- projeto: projetos, ideias, apps, negócios
- evento: aniversários, festas, datas recorrentes
- agenda: compromissos com data E hora específica
- rotina: horários fixos, hábitos, lembretes
- preferencia: gostos, lugares favoritos, opiniões

IMPORTANTE: Se "Gaps aguardando resposta" indicar nome_esposa/nome_filho e o usuário responder com um nome, classifique como "familia" com has_new_facts: true.

Retorne APENAS JSON:
{"has_new_facts": true, "contexts": ["familia"]}`;

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
    supabase.from('user_profiles').select('personality_notes, city, current_job').eq('user_id', userId).maybeSingle(),
    supabase.from('children').select('name').eq('parent_id', userId),
  ]);

  const profile    = profileRes.data;
  const childNames = (childrenRes.data || []).map((c: any) => c.name);
  const conjugeMatch = profile?.personality_notes?.match(/C.njuge: ([^\n(|]+)/);
  const conjugeNome  = conjugeMatch?.[1]?.trim();

  const prompt = `Identifique lacunas de informação na troca abaixo.

Usuário: "${userMessage}"
Assistente: "${aiReply}"

Já sabemos:
- Cônjuge: ${conjugeNome || 'desconhecido'}
- Filhos: ${childNames.join(', ') || 'nenhum'}
- Cidade: ${profile?.city || 'desconhecida'}
- Profissão: ${profile?.current_job || 'desconhecida'}

Contextos detectados: ${contexts.join(', ')}

Retorne APENAS JSON com gaps que realmente precisam ser preenchidos (máx 2):
{
  "gaps": [
    {
      "field": "nome_esposa",
      "context": "usuário mencionou aniversário da esposa mas nome é desconhecido",
      "hint": "Que legal! E como ela se chama?",
      "urgencia": "alta"
    }
  ]
}

Campos válidos: nome_esposa, nome_marido, nome_filho, tema_evento, data_evento, nome_medico, nome_projeto
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
// EXTRATORES ESPECIALIZADOS
// ============================================================

async function extractPerfil(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia dados de perfil pessoal mencionados explicitamente.
Retorne APENAS JSON (null para não mencionados):

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{"cidade": null, "estado": null, "cidade_natal": null, "nascimento": null, "profissao": null, "empresa": null, "genero": null}`;

  try {
    const data = JSON.parse(await callAI(prompt, 200));
    const patch: Record<string, any> = {};

    if (data.cidade)       patch.city        = data.cidade;
    if (data.estado)       patch.state       = data.estado;
    if (data.cidade_natal) patch.birth_city  = data.cidade_natal;
    if (data.nascimento)   patch.birth_date  = data.nascimento;
    if (data.profissao)    patch.current_job = data.profissao;
    if (data.empresa)      patch.company     = data.empresa;
    if (data.genero) {
      const g = data.genero.toLowerCase();
      patch.gender = g.includes('masc') || g === 'm' ? 'masculino'
                   : g.includes('fem')  || g === 'f' ? 'feminino'
                   : 'prefiro_nao_dizer';
    }

    if (Object.keys(patch).length === 0) return;
    patch.user_id    = userId;
    patch.updated_at = new Date().toISOString();
    await supabase.from('user_profiles').upsert(patch, { onConflict: 'user_id' });
    console.log('[Extrator/perfil]', Object.keys(patch).join(', '));
  } catch (e) {
    console.error('[Extrator/perfil] Erro:', e);
  }
}

async function extractFamilia(
  userId: string,
  userMessage: string,
  aiReply: string,
  gaps: DetectedGap[]
): Promise<void> {
  const hasEsposaGap = gaps.some(g => g.field === 'nome_esposa' || g.field === 'nome_marido');
  const hasFilhoGap  = gaps.some(g => g.field === 'nome_filho');

  const prompt = `Extraia dados familiares mencionados.
${hasEsposaGap ? 'ATENÇÃO: O usuário está fornecendo o nome do cônjuge — extraia com prioridade.' : ''}
${hasFilhoGap  ? 'ATENÇÃO: O usuário está fornecendo o nome de um filho — extraia com prioridade.' : ''}
Retorne APENAS JSON (null para não mencionados):

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "esposa": {"nome": null, "aniversario": null},
  "marido": {"nome": null, "aniversario": null},
  "filhos": []
}

filhos: [{"nome": "Miguel", "idade": 5}] apenas se mencionados.`;

  try {
    const data = JSON.parse(await callAI(prompt, 300));

    const conjuge = data.esposa?.nome ? data.esposa : data.marido?.nome ? data.marido : null;
    if (conjuge?.nome) {
      // Busca notes existente para não sobrescrever outros dados
      const { data: existing } = await supabase
        .from('user_profiles')
        .select('personality_notes')
        .eq('user_id', userId)
        .maybeSingle();

      const oldNotes  = existing?.personality_notes || '';
      const conjugeRegex = /C.njuge: [^\n]*/;
      const newNote   = `Cônjuge: ${conjuge.nome}${conjuge.aniversario ? ` (aniv: ${conjuge.aniversario})` : ''}`;
      const newNotes  = conjugeRegex.test(oldNotes)
        ? oldNotes.replace(conjugeRegex, newNote)
        : `${oldNotes}\n${newNote}`.trim();

      await supabase.from('user_profiles').upsert(
        { user_id: userId, personality_notes: newNotes, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
      console.log('[Extrator/familia] Cônjuge:', conjuge.nome);

      if (conjuge.aniversario) {
        await upsertEvent(userId, {
          title:           `Aniversário ${conjuge.nome}`,
          event_date:      normalizeDate(conjuge.aniversario),
          category:        'family',
          ...EVENT_WEIGHTS.aniversario_esposa,
        });
      }
    }

    for (const filho of (data.filhos || [])) {
      if (!filho.nome) continue;
      const birthYear  = filho.idade ? new Date().getFullYear() - filho.idade : null;
      const birth_date = birthYear ? `${birthYear}-01-01` : null;
      const life_phase = getLifePhase(filho.idade);

      const { data: ex } = await supabase
        .from('children').select('id').eq('parent_id', userId).eq('name', filho.nome).maybeSingle();

      if (ex?.id) {
        await supabase.from('children')
          .update({ birth_date, life_phase, updated_at: new Date().toISOString() })
          .eq('id', ex.id);
      } else {
        await supabase.from('children').insert({
          parent_id: userId, name: filho.nome, birth_date, life_phase,
          updated_at: new Date().toISOString(),
        });
      }

      if (birth_date) {
        await upsertEvent(userId, {
          title:     `Aniversário ${filho.nome}`,
          event_date: birth_date,
          category:  'family',
          notes:     `${life_phase} — ${filho.idade} anos`,
          ...EVENT_WEIGHTS.aniversario_filho,
        });
      }
      console.log('[Extrator/familia] Filho:', filho.nome);
    }
  } catch (e) {
    console.error('[Extrator/familia] Erro:', e);
  }
}

async function extractProjeto(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia projetos ou ideias mencionados.
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "projetos": [
    {"nome": "Procuro Quem Faça", "tag": "pqf", "descricao": "...", "status": "beta"}
  ]
}

status: ideia | em_desenvolvimento | beta | producao | pausado
tag: slug lowercase sem espaços
Retorne projetos: [] se nenhum mencionado.`;

  try {
    const data = JSON.parse(await callAI(prompt, 300));
    for (const proj of (data.projetos || [])) {
      if (!proj.nome || !proj.tag) continue;
      await supabase.from('projects').upsert(
        {
          tag:               proj.tag,
          name:              proj.nome,
          description:       proj.descricao || null,
          context_technical: proj.contexto_tecnico || null,
          user_id:           userId,
          status:            proj.status || 'em_desenvolvimento',
          updated_at:        new Date().toISOString(),
        },
        { onConflict: 'tag' }
      );
      console.log('[Extrator/projeto]', proj.nome);
    }
  } catch (e) {
    console.error('[Extrator/projeto] Erro:', e);
  }
}

async function extractEvento(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia eventos ou datas comemorativas mencionados (NÃO inclua compromissos com hora).
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "eventos": [
    {"titulo": "Festa Junina da Escola", "data": "2026-06-15", "tipo": "festa_escola", "recorrente": false, "notas": "escola do Miguel"}
  ]
}

Tipos: aniversario_esposa | aniversario_filho | aniversario_familiar | aniversario_amigo | festa_escola | evento_escolar | consulta_medica | compromisso_trabalho | entrega_projeto | default
data: YYYY-MM-DD (ano atual se não informado)
Retorne eventos: [] se nenhum mencionado.`;

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

async function extractAgenda(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia compromissos pontuais com data E hora específicas.
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{
  "compromissos": [
    {"descricao": "Consulta Dr. Adriano", "data_hora": "2026-03-10T10:00:00-03:00", "categoria": "Saúde"}
  ]
}

Categorias: Saúde | Trabalho | Escola | Família | Pessoal | Rotina
Só inclua se tiver data E hora explícitas.
Retorne compromissos: [] se nenhum mencionado.`;

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

async function extractRotina(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia informações de rotina mencionadas explicitamente.
Retorne APENAS JSON (null para não mencionados):

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{"despertar": null, "dormir": null, "academia_horario": null, "trabalho_entrada": null, "trabalho_saida": null, "lembretes": []}`;

  try {
    const data  = JSON.parse(await callAI(prompt, 200));
    const parts: string[] = [];
    if (data.despertar)        parts.push(`Despertar: ${data.despertar}`);
    if (data.dormir)           parts.push(`Dormir: ${data.dormir}`);
    if (data.academia_horario) parts.push(`Academia: ${data.academia_horario}`);
    if (data.trabalho_entrada) parts.push(`Trabalho entrada: ${data.trabalho_entrada}`);
    if (data.trabalho_saida)   parts.push(`Trabalho saída: ${data.trabalho_saida}`);
    if (data.lembretes?.length) parts.push(`Lembretes: ${data.lembretes.join(', ')}`);
    if (parts.length === 0) return;

    const { data: prof } = await supabase.from('user_profiles')
      .select('personality_notes').eq('user_id', userId).maybeSingle();
    const old      = prof?.personality_notes || '';
    const newBlock = `[ROTINA] ${parts.join(' | ')}`;
    const updated  = /\[ROTINA\]/i.test(old) ? old.replace(/\[ROTINA\][^\n]*/i, newBlock) : `${old}\n${newBlock}`.trim();

    await supabase.from('user_profiles').upsert(
      { user_id: userId, personality_notes: updated, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
    console.log('[Extrator/rotina]', parts.join(' | '));
  } catch (e) {
    console.error('[Extrator/rotina] Erro:', e);
  }
}

async function extractPreferencia(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia preferências pessoais mencionadas.
Retorne APENAS JSON:

Usuário: "${userMessage}"
Assistente: "${aiReply}"

{"preferencias": [{"tipo": "lugar", "descricao": "Feira do Produtor na Rua São Vicente aos sábados"}]}

Tipos: lugar | comida | filme | musica | esporte | hobby | outro
Retorne preferencias: [] se nenhuma mencionada.`;

  try {
    const data  = JSON.parse(await callAI(prompt, 200));
    const prefs: any[] = data.preferencias || [];
    if (prefs.length === 0) return;

    const { data: prof } = await supabase.from('user_profiles')
      .select('career_notes').eq('user_id', userId).maybeSingle();
    const old     = prof?.career_notes || '';
    const newLine = prefs.map((p: any) => `[${p.tipo}] ${p.descricao}`).join(' | ');
    const updated = old ? `${old} | ${newLi
