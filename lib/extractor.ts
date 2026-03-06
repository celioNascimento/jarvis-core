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
    supabase.from('user_profiles').select('spouse_name, city, current_job').eq('user_id', userId).maybeSingle(),
    supabase.from('children').select('name').eq('parent_id', userId),
  ]);

  const profile    = profileRes.data;
  const childNames = (childrenRes.data || []).map((c: any) => c.name);
  const conjugeNome = profile?.spouse_name;

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

REGRAS:
- Se cidade mencionada e estado conhecido (ex: Londrina → PR), infira o estado. Sigla 2 letras.
- nascimento: formato YYYY-MM-DD
- fe: "christian_declared" | "open" | "none" (null se não mencionado)
- escolaridade: "fundamental" | "medio" | "tecnico" | "superior_cursando" | "superior_completo" | "pos_graduacao" | "mestrado" | "doutorado"
- qtd_irmaos: número inteiro
- Retorne null para qualquer campo não mencionado explicitamente`;

  try {
    const data = JSON.parse(await callAI(prompt, 300));
    const patch: Record<string, any> = {};

    if (data.nome_completo) patch.full_name   = data.nome_completo;
    if (data.cidade)        patch.city        = data.cidade;
    if (data.estado)        patch.state       = data.estado;
    if (data.cidade_natal)  patch.birth_city  = data.cidade_natal;
    if (data.estado_natal)  patch.birth_state = data.estado_natal;
    if (data.nascimento)    patch.birth_date  = data.nascimento;
    if (data.profissao)     patch.current_job = data.profissao;
    if (data.empresa)       patch.company     = data.empresa;
    if (data.whatsapp)      patch.whatsapp    = data.whatsapp;
    if (data.nome_pai)      patch.father_name = data.nome_pai;
    if (data.nome_mae)      patch.mother_name = data.nome_mae;
    if (data.qtd_irmaos !== null && data.qtd_irmaos !== undefined) {
      patch.siblings_count = parseInt(data.qtd_irmaos);
    }
    if (data.fe)            patch.faith_profile = data.fe;
    if (data.fe_notas)      patch.faith_notes   = data.fe_notas;
    if (data.escolaridade)  patch.education_level = data.escolaridade;
    if (data.escola) {
      // schools é array — busca existente para não sobrescrever
      const { data: prof } = await supabase
        .from('user_profiles').select('schools').eq('user_id', userId).maybeSingle();
      const existing = prof?.schools || [];
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
  "esposa": {"nome": null, "aniversario": null, "telefone": null},
  "marido": {"nome": null, "aniversario": null, "telefone": null},
  "filhos": []
}

filhos: [{"nome": "Miguel", "idade": 5, "genero": "m"}] apenas se mencionados.`;

  try {
    const data = JSON.parse(await callAI(prompt, 300));

    const conjuge = data.esposa?.nome ? data.esposa : data.marido?.nome ? data.marido : null;
    if (conjuge?.nome) {
      const spousePatch: Record<string, any> = {
        user_id:     userId,
        spouse_name: conjuge.nome,
        updated_at:  new Date().toISOString(),
      };
      if (conjuge.aniversario) spousePatch.spouse_birthday = normalizeDate(conjuge.aniversario);
      if (conjuge.telefone)    spousePatch.spouse_phone    = conjuge.telefone;

      await supabase.from('user_profiles').upsert(spousePatch, { onConflict: 'user_id' });
      console.log('[Extrator/familia] Cônjuge:', conjuge.nome);

      if (conjuge.aniversario) {
        await upsertEvent(userId, {
          title:      `Aniversário ${conjuge.nome}`,
          event_date: normalizeDate(conjuge.aniversario),
          category:   'family',
          ...EVENT_WEIGHTS.aniversario_esposa,
        });
      }
    }

    for (const filho of (data.filhos || [])) {if (!filho.nome) continue;
      const birthYear  = filho.idade ? new Date().getFullYear() - filho.idade : null;
      const birth_date = birthYear ? `${birthYear}-01-01` : null;
      const life_phase = getLifePhase(filho.idade);

      const { data: ex } = await supabase
        .from('children').select('id').eq('parent_id', userId).eq('name', filho.nome).maybeSingle();

      if (ex?.id) {
        await supabase.from('children')
          .update({ birth_date, life_phase, gender: filho.genero || null, updated_at: new Date().toISOString() })
          .eq('id', ex.id);
      } else {
        await supabase.from('children').insert({
          parent_id: userId, name: filho.nome, birth_date, life_phase,
          gender: filho.genero || null,
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
// ATUALIZA L3 A PARTIR DAS TABELAS
// ============================================================

async function updateL3(userId: string): Promise<void> {
  try {
    const [profRes, kidsRes, projRes, evRes, userRes] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('children').select('name, birth_date, life_phase').eq('parent_id', userId),
      supabase.from('projects').select('name, description').eq('user_id', userId).limit(10),
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
    if (p?.city)        patches['Localização'] = `${p.city}${p.state ? `, ${p.state}` : ''}`;
    if (p?.birth_city)  patches['Origem']      = p.birth_city;
    if (p?.current_job) patches['Emprego']     = `${p.current_job}${p.company ? ` @ ${p.company}` : ''}`;
    if (p?.birth_date)  patches['Nascimento']  = p.birth_date;
    if (p?.faith_profile && p.faith_profile !== 'unknown') patches['Fé'] = p.faith_profile;

    if (p?.spouse_name) patches['Esposa'] = p.spouse_name;

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
      const block   = proj.map((r: any) => `- ${r.name}: ${r.description || ''}`).join('\n');
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

    await supabase.from('users').update({ current_context: ctx.trim() }).eq('id', userId);
    console.log('[Extrator/L3] Patches:', Object.keys(patches).join(', '));
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
  const months: Record<string, string> = {
    janeiro: '01', fevereiro: '02', marco: '03', abril: '04',
    maio: '05', junho: '06', julho: '07', agosto: '08',
    setembro: '09', outubro: '10', novembro: '11', dezembro: '12',
  };
  const year     = new Date().getFullYear();
  const ptMatch  = raw.match(/(\d{1,2})\s+de?\s+(\w+)/i);
  if (ptMatch) {
    const month = months[ptMatch[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')];
    if (month) return `${year}-${month}-${ptMatch[1].padStart(2, '0')}`;
  }
  const parts = raw.split(/[-/]/);
  if (parts.length === 2) return `${year}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  return raw;
}

function getCategoryFromType(tipo: string): string {
  if (/escola|escolar/.test(tipo))          return 'school';
  if (/medic|saude/.test(tipo))             return 'health';
  if (/trabalho|projeto/.test(tipo))        return 'work';
  if (/aniversario|familiar/.test(tipo))    return 'family';
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