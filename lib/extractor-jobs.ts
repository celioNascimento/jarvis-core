// ============================================================
// lib/extractor-jobs.ts
// Parte 2: extratores de jobs, L3 e helpers compartilhados
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { safeParseJSON } from './extractor';
import { callOpenRouter } from './jarvis';
import { scheduleReminderOnQStash } from '@/lib/qstash';

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

      const { data: existing } = await supabase.from('projects')
        .select('description, context_technical, status')
        .eq('user_id', userId).eq('tag', proj.tag).maybeSingle();

      const payload: Record<string, any> = {
        user_id: userId, tag: proj.tag, name: proj.nome,
        updated_at: new Date().toISOString(),
      };

      if (proj.descricao) {
        if (!existing?.description || proj.descricao.length > existing.description.length) {
          payload.description = proj.descricao;
        }
      }
      if (proj.contexto_tecnico && !existing?.context_technical) {
        payload.context_technical = proj.contexto_tecnico;
      }
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
  aniversario_proprio: { priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 1.00 },
  aniversario_casamento: { priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 1.00 },
  aniversario_esposa: { priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 0.95 },
  aniversario_marido: { priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 0.95 },
  aniversario_filho: { priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 0.90 },
  aniversario_familiar: { priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 0.80 },
  aniversario_amigo: { priority: 'media', decay_type: 'recurring_annual', emotional_weight: 0.50 },
  natal: { priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 0.85 },
  pascoa: { priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 0.80 },
  ano_novo: { priority: 'media', decay_type: 'recurring_annual', emotional_weight: 0.60 },
  festa_escola: { priority: 'media', decay_type: 'one_time', emotional_weight: 0.60 },
  evento_escolar: { priority: 'media', decay_type: 'one_time', emotional_weight: 0.55 },
  consulta_medica: { priority: 'alta', decay_type: 'deadline', emotional_weight: 0.70 },
  compromisso_trabalho: { priority: 'media', decay_type: 'deadline', emotional_weight: 0.40 },
  entrega_projeto: { priority: 'alta', decay_type: 'deadline', emotional_weight: 0.60 },
  inicio_emprego: { priority: 'media', decay_type: 'one_time', emotional_weight: 0.50 },
  default: { priority: 'media', decay_type: 'one_time', emotional_weight: 0.50 },
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
// EXTRATOR: AGENDA → agenda + notificações QStash
// ============================================================
 
export async function extractAgenda(userId: string, userMessage: string): Promise<void> {
  const anoAtual = new Date().getFullYear();
  const mesAtual = String(new Date().getMonth() + 1).padStart(2, '0');
  const diaAtual = String(new Date().getDate()).padStart(2, '0');

  const prompt = `Extraia compromissos com data E hora explícitas mencionados pelo USUÁRIO.
  Retorne APENAS JSON:

  Mensagem do usuário: "${userMessage}"

  {"compromissos": [{"descricao": null, "data_hora": null, "categoria": null, "aviso_minutos": 30}]}

  ANO ATUAL: ${anoAtual}. Data de hoje: ${anoAtual}-${mesAtual}-${diaAtual}.
  data_hora: ISO 8601 fuso -03:00. SEMPRE use o ano ${anoAtual} a menos que o usuário mencione outro ano explicitamente.
  
  EXEMPLOS DE CONVERSÃO (ano atual = ${anoAtual}):
  - "sexta às 9h" ou "dia 08/05 às 9h" → "${anoAtual}-05-08T09:00:00-03:00"
  - "amanhã às 14h" → "${anoAtual}-${mesAtual}-${String(new Date().getDate() + 1).padStart(2, '0')}T14:00:00-03:00"
  - "segunda que vem às 10h" → calcule a data correta em ${anoAtual}
  - NUNCA gere datas em 2024 ou anos anteriores

  aviso_minutos: Tente inferir se o usuário pediu para ser avisado com antecedência. Se não mencionar, use 30.
  Categorias: Saúde|Trabalho|Escola|Família|Pessoal|Rotina
  Retorne compromissos: [] se nenhum mencionado`;

  try {
    const raw = await callAI(prompt, 250);
    const data = safeParseJSON(raw);
    if (!data) { console.error('[Extrator/agenda] JSON inválido:', raw.slice(0, 100)); return; }

    const { data: userData } = await supabase
      .from('users')
      .select('auth_user_id')
      .eq('id', userId)
      .single();
    const authUserId = userData?.auth_user_id;

    for (const comp of (data.compromissos || [])) {
      if (!comp.descricao || !comp.data_hora) continue;

      // Garante que o ano não seja anterior ao atual
      const dataHora = comp.data_hora as string;
      const anoEvento = parseInt(dataHora.substring(0, 4));
      if (anoEvento < anoAtual) {
        console.warn(`[Extrator/agenda] Ano inválido (${anoEvento}), corrigindo para ${anoAtual}:`, comp.descricao);
        comp.data_hora = String(anoAtual) + dataHora.substring(4);
      }

      const startAt = new Date(comp.data_hora);
      if (isNaN(startAt.getTime())) {
        console.error('[Extrator/agenda] data_hora inválida:', comp.data_hora);
        continue;
      }

      const endAt = new Date(startAt.getTime() + 3600000);

      // ── Checa duplicata em jarvis.events ──
      const { data: exEvents } = await supabase
        .schema('jarvis')
        .from('events')
        .select('id')
        .eq('user_id', Number(userId))
        .eq('title', comp.descricao)
        .eq('start_at', startAt.toISOString())
        .maybeSingle();

      if (exEvents) {
        console.log('[Extrator/agenda] Duplicata ignorada:', comp.descricao);
        continue;
      }

      // 1. Salva em jarvis.events (fonte principal)
      const { error: evError } = await supabase
        .schema('jarvis')
        .from('events')
        .insert({
          user_id:          Number(userId),
          title:            comp.descricao,
          start_at:         startAt.toISOString(),
          end_at:           endAt.toISOString(),
          all_day:          false,
          category:         mapCategoriaToCategory(comp.categoria),
          source:           'lev',
          reminder_minutes: [comp.aviso_minutos ?? 30],
        });

      if (evError) {
        console.error('[Extrator/agenda] Erro ao salvar em jarvis.events:', evError.message);
        continue;
      }

      console.log('[Extrator/agenda] Salvo em jarvis.events:', comp.descricao);

      // 2. Cria lembrete + QStash
      if (authUserId) {
        const delayMinutes = comp.aviso_minutos ?? 30;
        const notifyTime  = new Date(startAt.getTime() - delayMinutes * 60000).toISOString();

        if (new Date(notifyTime).getTime() > Date.now()) {
          const { data: reminder, error: remError } = await supabase
            .schema('jarvis')
            .from('reminders')
            .insert({
              user_id:        Number(userId),
              title:          `📅 ${comp.descricao}`,
              type:           'agenda',
              scheduled_time: notifyTime,
              status:         'pending',
              metadata:       { auth_user_id: authUserId },
            })
            .select('id')
            .single();

          if (!remError && reminder) {
            const qstashId = await scheduleReminderOnQStash({
              reminderId:    String(reminder.id),
              userId:        userId,
              authUserId:    authUserId,
              message:       `📅 [Agenda] ${comp.descricao}`,
              scheduledTime: notifyTime,
            });

            if (qstashId) {
              await supabase
                .schema('jarvis')
                .from('reminders')
                .update({ qstash_message_id: qstashId })
                .eq('id', reminder.id);
            }
            console.log(`[Extrator/agenda] Push configurado para ${delayMinutes}min antes.`);
          }
        }
      }
    }
  } catch (e) {
    console.error('[Extrator/agenda] Erro:', e);
  }
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
    if (data.despertar) parts.push(`Despertar: ${data.despertar}`);
    if (data.dormir) parts.push(`Dormir: ${data.dormir}`);
    if (data.academia_horario) parts.push(`Academia: ${data.academia_horario}`);
    if (data.trabalho_entrada) parts.push(`Entrada: ${data.trabalho_entrada}`);
    if (data.trabalho_saida) parts.push(`Saída: ${data.trabalho_saida}`);
    if (data.lembretes?.length) parts.push(`Lembretes: ${data.lembretes.join(', ')}`);
    if (parts.length === 0) return;

    const { data: prof } = await supabase.from('user_profiles')
      .select('personality_notes').eq('user_id', userId).maybeSingle();
    const old = prof?.personality_notes || '';
    const newBlock = `[ROTINA] ${parts.join(' | ')}`;
    const updated = /\[ROTINA\]/i.test(old)
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
    const raw = await callAI(prompt, 200);
    const data = safeParseJSON(raw);
    if (!data) { console.error('[Extrator/preferencia] JSON inválido:', raw.slice(0, 100)); return; }
    const prefs: any[] = data.preferencias || [];
    if (prefs.length === 0) return;

    const { data: prof } = await supabase.from('user_profiles')
      .select('career_notes').eq('user_id', userId).maybeSingle();
    const old = prof?.career_notes || '';
    const newLine = prefs.map((p: any) => `[${p.tipo}] ${p.descricao}`).join(' | ');
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
// ATUALIZA L3 — users.current_context (Com Vínculos Compartilhados)
// ============================================================

export async function updateL3(userId: string): Promise<void> {
  try {
    // ── A GUILHOTINA DO TEMPO ──
    // Gera a data de hoje no formato YYYY-MM-DD para o fuso correto
    const today = new Intl.DateTimeFormat('en-CA', { 
      timeZone: 'America/Sao_Paulo' 
    }).format(new Date());

    // ── 1. BUSCA EVENTOS COMPARTILHADOS (Ex: Agenda da Giselle) ──
    const { data: sharedWithMe } = await supabase
      .from('event_shares')
      .select('event_id')
      .eq('shared_with_id', userId)
      .eq('active', true);

    const sharedIds = sharedWithMe?.map(s => s.event_id) || [];
    
    // Monta a string do filtro OR dinamicamente
    const eventOrFilter = sharedIds.length > 0
      ? `user_id.eq.${userId},id.in.(${sharedIds.join(',')})`
      : `user_id.eq.${userId}`;

    // ── 2. CARREGA TUDO EM PARALELO ──
    const [profRes, kidsRes, projRes, evRes, userRes] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('children').select('name, birth_date, life_phase, gender').eq('parent_id', userId),
      supabase.from('projects').select('name, description, status').eq('user_id', userId).limit(10),
      
      // ── FILTRO DE EVENTOS (Próprios + Compartilhados) ──
      supabase.from('events')
        .select('title, start_at, emotional_weight')
        .or(eventOrFilter) // Aplica a visão expandida
        .gte('start_at', today) // Ignora o passado
        .order('start_at', { ascending: true })
        .limit(15), // Aumentado levemente para caber os dois calendários
        
      supabase.from('users').select('current_context').eq('id', userId).single(),
    ]);

    const p = profRes.data;
    const kids = kidsRes.data || [];
    const proj = projRes.data || [];
    const evs = evRes.data || [];
    let ctx = userRes.data?.current_context || '';

    const patches: Record<string, string> = {};

    // Mapeamento de Perfil
    if (p?.full_name) {
      patches['Nome'] = p.preferred_name
        ? `${p.full_name} (prefere: ${p.preferred_name})`
        : p.full_name;
    }
    if (p?.gender) patches['Gênero'] = p.gender;
    if (p?.birth_date) patches['Nascimento'] = p.birth_date;
    if (p?.city) patches['Mora em'] = `${p.city}${p.state ? `, ${p.state}` : ''}`;
    if (p?.phone) patches['Telefone'] = p.phone;
    if (p?.whatsapp) patches['WhatsApp'] = p.whatsapp;
    if (p?.spouse_name) patches['Cônjuge'] = `${p.spouse_name}${p.spouse_birthday ? ` (aniv: ${p.spouse_birthday})` : ''}`;
    if (p?.father_name) patches['Pai'] = p.father_name;
    if (p?.mother_name) patches['Mãe'] = p.mother_name;
    if (p?.profession) patches['Formação'] = p.profession;
    if (p?.current_job) patches['Cargo'] = `${p.current_job}${p.company ? ` @ ${p.company}` : ''}`;
    if (p?.faith_profile && p.faith_profile !== 'unknown') patches['Fé'] = p.faith_profile;

    if (kids.length > 0) {
      patches['Filhos'] = kids.map((k: any) => {
        const age = k.birth_date
          ? new Date().getFullYear() - new Date(k.birth_date).getFullYear()
          : null;
        return `${k.name}${age !== null ? ` (${age} anos)` : ''}`;
      }).join(', ');
    }

    // Aplica Patches no Contexto Principal
    const changed: string[] = [];
    for (const [key, val] of Object.entries(patches)) {
      const rx = new RegExp(`- ${key}: (.*)`, 'i');
      const match = ctx.match(rx);
      const current = match?.[1]?.trim() || '';
      if (current === val) continue;
      const line = `- ${key}: ${val}`;
      ctx = match ? ctx.replace(rx, line) : `${ctx}\n${line}`;
      changed.push(key);
    }

    // Seção de Projetos
    if (proj.length > 0) {
      const block = proj.map((r: any) => `- ${r.name}${r.status ? ` [${r.status}]` : ''}: ${r.description || ''}`).join('\n');
      const section = `## PROJETOS\n${block}`;
      const existProj = /## PROJETOS[\s\S]*?(?=\n##|$)/i.exec(ctx)?.[0] || '';
      if (existProj !== section) {
        ctx = existProj ? ctx.replace(/## PROJETOS[\s\S]*?(?=\n##|$)/i, section) : `${ctx}\n\n${section}`;
        changed.push('Projetos');
      }
    }

    // Seção de Datas Importantes (Apenas as que não passaram)
    const highEvs = evs.filter((e: any) => (e.emotional_weight || 0) >= 0.7);
    if (highEvs.length > 0) {
      const block = highEvs.map((e: any) => `- ${e.title}: ${e.start_at}`).join('\n');
      const section = `## DATAS IMPORTANTES\n${block}`;
      const existDatas = /## DATAS IMPORTANTES[\s\S]*?(?=\n##|$)/i.exec(ctx)?.[0] || '';
      if (existDatas !== section) {
        ctx = existDatas ? ctx.replace(/## DATAS IMPORTANTES[\s\S]*?(?=\n##|$)/i, section) : `${ctx}\n\n${section}`;
        changed.push('Datas');
      }
    }

    if (changed.length > 0) {
      await supabase.from('users').update({ current_context: ctx.trim() }).eq('id', userId);
      console.log('[Extrator/L3] Memória atualizada com eventos compartilhados:', changed.join(', '));
    }
  } catch (e) {
    console.error('[Extrator/L3] Erro crítico:', e);
  }
}
// ============================================================
// HELPERS COMPARTILHADOS
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
    user_id: userId,
    alias: alias.toLowerCase().trim(),
    refers_to_type: type,
    refers_to_id: referId,
    refers_to_name: referName,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,alias' });
}

function normalizeEventTitle(t: string): string {
  const s = t.trim();
  if (/^aniversári[oa]?\s+de\s+\w/i.test(s)) return s;
  const sem_da = s.replace(/^(aniversári[oa]?\s+)(d[ao]\s+)/gi, '$1');
  return sem_da
    .replace(/^(aniversári[oa]?\s+)(\S+)(\s+\S+)+$/gi, (_, prefix, first) => `${prefix}${first}`)
    .trim();
}

function fuzzyTitleKey(t: string): string {
  return t.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^(inicio|começo|comeco|novo emprego|start|entrada)\s+(na?|em|no|ao)?\s*/i, 'inicio ')
    .replace(/^(aniversari[oa]?)\s+(de\s+)?/i, 'aniversario ')
    .replace(/\s+/g, ' ').trim();
}

const recentInserts = new Map<string, number>();

export async function upsertEvent(userId: string, ev: {
  title: string; event_date: string; category: string;
  priority: string; decay_type: string; emotional_weight: number;
  is_recurring?: boolean; notes?: string | null;
}): Promise<void> {
  const title = normalizeEventTitle(ev.title);

  const titulosRejeitados = /^(aniversário|aniversario|evento|compromisso|data|lembrete)$/i;
  if (titulosRejeitados.test(title.trim())) {
    console.log('[upsertEvent] Rejeitado (título genérico):', title);
    return;
  }

  const norm = (s: string) => s.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');

  const mmdd = ev.event_date.slice(5);
  const titleKey = fuzzyTitleKey(title);
  const dedupKey = `${userId}:${titleKey}:${mmdd}`;

  const lastInsert = recentInserts.get(dedupKey) || 0;
  if (Date.now() - lastInsert < 10_000) {
    console.log('[upsertEvent] Ignorado (cache):', title);
    return;
  }

  // CORREÇÃO 1: Buscando pela coluna correta (start_at) no LIKE
  const { data: candidates } = await supabase.from('events')
    .select('id, title, priority, emotional_weight, notes, decay_type, is_recurring')
    .eq('user_id', userId)
    .like('start_at', `%-${mmdd}`); // <-- Antes era event_date

  const ex = (candidates || []).find((c: any) => {
    const cn = norm(normalizeEventTitle(c.title));
    const tn = norm(title);
    if (cn === tn) return true;
    if (fuzzyTitleKey(c.title) === titleKey) return true;
    const cf = cn.replace(/aniversari[oa]?\s+(de\s+)?/, '').split(' ')[0];
    const tf = tn.replace(/aniversari[oa]?\s+(de\s+)?/, '').split(' ')[0];
    return tf.length > 2 && cf === tf;
  });

  recentInserts.set(dedupKey, Date.now());

  if (ex?.id) {
    const betterPriority = ev.priority === 'alta' && ex.priority !== 'alta';
    const betterWeight = ev.emotional_weight > (ex.emotional_weight || 0);
    const hasNewNote = ev.notes && !ex.notes;
    const titleImproved = norm(title) !== norm(ex.title);

    if (!betterPriority && !betterWeight && !hasNewNote && !titleImproved) {
      console.log('[upsertEvent] Ignorado (sem melhoria):', title);
      return;
    }
    await supabase.from('events').update({
      title,
      ...(betterPriority ? { priority: ev.priority } : {}),
      ...(betterWeight ? { emotional_weight: ev.emotional_weight } : {}),
      ...(hasNewNote ? { notes: ev.notes } : {}),
    }).eq('id', ex.id);
    console.log('[upsertEvent] Atualizado:', title);
  } else {
    // CORREÇÃO 2: Inserindo na coluna correta (start_at)
    await supabase.from('events').insert({
      user_id: userId,
      title,
      start_at: ev.event_date, // <-- Antes era event_date
      category: ev.category,
      priority: ev.priority,
      decay_type: ev.decay_type,
      emotional_weight: ev.emotional_weight,
      is_recurring: ev.is_recurring ?? ev.decay_type === 'recurring_annual',
      notes: ev.notes || null,
      last_notified_year: null,
      relevance_score: 1.0,
    });
    console.log('[upsertEvent] Inserido:', title);
  }
}

// ============================================================
// EXTRATOR: RECOMENDAÇÕES → recommendations
// ============================================================

export async function extractRecomendacao(
  userId: string,
  userMessage: string,
  aiReply: string
): Promise<void> {
  const prompt = `Analise a conversa e extraia recomendações de lugares, produtos, serviços ou pessoas.

  Mensagem do usuário: "${userMessage}"
  Resposta do assistente: "${aiReply}"

  Retorne APENAS JSON:
  {"recomendacoes": [
    {
      "tipo": "lugar|produto|servico|pessoa",
      "nome": null,
      "descricao": null,
      "source": "jarvis|user|third_party",
      "source_person": null,
      "context": null,
      "status": "pending|liked|disliked",
      "tags": []
    }
  ]}

  REGRAS:
  - source="jarvis": assistente sugeriu algo ao usuário
  - source="user": usuário disse que foi/usou e gostou ("fui no X e adorei")
  - source="third_party": usuário mencionou que alguém indicou ("meu amigo indicou o X")
  - source_person: nome de quem indicou (apenas para source="third_party")
  - status="liked": usuário expressou que gostou ("adorei", "recomendo", "muito bom")
  - status="disliked": usuário expressou que não gostou
  - status="pending": sugestão ainda não visitada/testada
  - context: motivo ou contexto da recomendação
  - tags: array de palavras-chave relevantes
  - nome: NUNCA retornar null — se não houver nome claro, retorne recomendacoes: []
  - Retorne recomendacoes: [] se nenhuma recomendação clara na conversa`;

  try {
    const raw = await callAI(prompt, 400);
    const data = safeParseJSON(raw);
    if (!data) { console.error('[Extrator/recomendacao] JSON inválido:', raw.slice(0, 100)); return; }

    for (const rec of (data.recomendacoes || [])) {
      if (!rec.nome || !rec.tipo) continue;

      const { data: existing } = await supabase
        .from('recommendations')
        .select('id, status, context')
        .eq('user_id', userId)
        .eq('type', rec.tipo)
        .ilike('name', rec.nome)
        .maybeSingle();

      if (existing) {
        const shouldUpdate =
          (rec.status !== 'pending' && existing.status === 'pending') ||
          (rec.context && !existing.context);

        if (shouldUpdate) {
          await supabase.from('recommendations').update({
            ...(rec.status !== 'pending' ? { status: rec.status } : {}),
            ...(rec.context && !existing.context ? { context: rec.context } : {}),
            updated_at: new Date().toISOString(),
          }).eq('id', existing.id);
          console.log('[Extrator/recomendacao] Atualizado:', rec.nome);
        }
        continue;
      }

      await supabase.from('recommendations').insert({
        user_id: userId,
        type: rec.tipo,
        name: rec.nome,
        description: rec.descricao || null,
        source: rec.source || 'jarvis',
        source_person: rec.source_person || null,
        context: rec.context || null,
        status: rec.status || 'pending',
        tags: rec.tags || [],
      });
      console.log('[Extrator/recomendacao] Inserido:', rec.nome, `[${rec.tipo}]`);
    }
  } catch (e) { console.error('[Extrator/recomendacao] Erro:', e); }
}

// ============================================================
// LOADER: RECOMENDAÇÕES para o system prompt
// ============================================================

export async function buildRecommendationsBlock(
  userId: string,
  messageText: string
): Promise<string> {
  try {
    const { data: recs } = await supabase
      .from('recommendations')
      .select('type, name, description, source, source_person, context, status, tags')
      .eq('user_id', userId)
      .neq('status', 'disliked')
      .order('created_at', { ascending: false })
      .limit(30);

    if (!recs || recs.length === 0) return '';

    const msgLower = messageText.toLowerCase();

    const relevant = recs.filter((r: any) => {
      const nameMatch = r.name.toLowerCase().split(' ')
        .some((w: string) => w.length > 3 && msgLower.includes(w));
      const tagMatch = (r.tags || [])
        .some((t: string) => msgLower.includes(t.toLowerCase()));
      const askingForRec = /indica|recomend|sugere|onde|qual.*bom|tem.*bom/i.test(msgLower);
      return nameMatch || tagMatch || askingForRec;
    });

    if (relevant.length === 0) return '';

    const lines = relevant.map((r: any) => {
      const sourceTxt = r.source === 'third_party' && r.source_person
        ? `indicado por ${r.source_person}`
        : r.source === 'jarvis' ? 'sugerido pelo assistente' : 'mencionado por você';
      const statusTxt = r.status === 'liked' ? ' ✓ gostou' : '';
      const ctx = r.context ? ` — ${r.context}` : '';
      return `- [${r.type}] ${r.name}${ctx} (${sourceTxt}${statusTxt})`;
    });

    return `[RECOMENDAÇÕES]\n${lines.join('\n')}`;
  } catch (e) {
    console.error('[buildRecommendationsBlock] Erro:', e);
    return '';
  }
}

// ============================================================
// LOADER: TÓPICOS para o system prompt (L4)
// ============================================================

export async function buildTopicBlock(
  userId: string,
  messageText: string
): Promise<string> {
  try {
    const { data: topics } = await supabase
      .from('topic_index')
      .select('topic, label, summary, entry_count, last_indexed')
      .eq('user_id', userId)
      .order('entry_count', { ascending: false })
      .limit(40);

    if (!topics || topics.length === 0) return '';

    const msgLower = messageText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const relevant = topics.filter((t: any) => {
      const topicNorm = t.topic.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const labelNorm = t.label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const summaryNorm = (t.summary || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      const words = [...topicNorm.split('_'), ...labelNorm.split(' ')].filter(w => w.length > 3);
      const wordMatch = words.some(w => msgLower.includes(w));
      const summaryWords = summaryNorm.split(/\s+/).filter((w: string) => w.length > 4);
      const summaryMatch = summaryWords.some((w: string) => msgLower.includes(w));

      return wordMatch || summaryMatch;
    });

    const toShow = relevant.length > 0 ? relevant.slice(0, 8) : topics.slice(0, 5);

    const lines = toShow.map((t: any) => {
      const summary = t.summary ? ` — ${t.summary}` : '';
      return `- [${t.label}] ${t.topic}${summary}`;
    });

    return `[TÓPICOS RECORRENTES]\n${lines.join('\n')}`;
  } catch (e) {
    console.error('[buildTopicBlock] Erro:', e);
    return '';
  }
}

// ============================================================
// UTILITÁRIOS
// ============================================================

export function normalizeDate(raw: string): string {
  if (!raw) return raw;
  const months: Record<string, string> = {
    janeiro: '01', fevereiro: '02', marco: '03', abril: '04',
    maio: '05', junho: '06', julho: '07', agosto: '08',
    setembro: '09', outubro: '10', novembro: '11', dezembro: '12',
  };
  const currentYear = new Date().getFullYear();

  const ptMatch = raw.match(/(\d{1,2})\s+de?\s+(\w+)(\s+de?\s+(\d{4}))?/i);
  if (ptMatch) {
    const mon = months[ptMatch[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')];
    const year = ptMatch[4] || String(currentYear);
    if (mon) return `${year}-${mon}-${ptMatch[1].padStart(2, '0')}`;
  }

  const parts = raw.split(/[-/]/);

  if (parts.length === 3) {
    const [a, b, c] = parts;
    if (a.length === 4) return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
    if (c.length === 4) return `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    if (c.length === 2) return `20${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
  }

  if (parts.length === 2) {
    return `${currentYear}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }

  return raw;
}

export function getCategoryFromType(tipo: string): string {
  if (/escola|escolar/.test(tipo)) return 'school';
  if (/medic|saude/.test(tipo)) return 'health';
  if (/trabalho|projeto/.test(tipo)) return 'work';
  if (/aniversario|familiar/.test(tipo)) return 'family';
  return 'personal';
}

export function getLifePhase(age: number | null): string {
  if (age === null || age === undefined || age < 0) return 'child';
  if (age < 3) return 'baby';
  if (age <= 11) return 'child';
  if (age <= 17) return 'teen';
  if (age <= 24) return 'young_adult';
  return 'adult';
}

export async function extractShopping(userId: string, userMessage: string, aiReply: string = ''): Promise<void> {
  try {
    const prompt = `Você é o assistente Lev. Extraia os itens de compra mencionados.
    
    Mensagem do usuário: "${userMessage}"
    ${aiReply ? `Resposta do assistente (use como contexto para identificar os itens detalhados): "${aiReply}"` : ''}
    
    REGRA DE DETALHAMENTO (CRÍTICA):
    - NUNCA agrupe itens em categorias genéricas como "kit de skincare", "materiais de construção", ou "coisas de festa".
    - Se a mensagem pedir para adicionar um grupo ("itens de skincare", "esses produtos"), extraia CADA PRODUTO INDIVIDUALMENTE varrendo o contexto da Resposta do assistente.
    
    Retorne APENAS um JSON válido neste exato formato e NADA MAIS:
    {"items": [{"item": "nome do item", "category": "mercado"}]}
    
    Categorias válidas: mercado, higiene, farmacia, academia, reforma, casa, roupas, tecnologia, outros.
    Se não identificar nenhum item claro, retorne {"items": []}.`;

    const aiResponse = await callOpenRouter(prompt, "google/gemini-2.0-flash-001", 0.1);
    
    // ── CORREÇÃO: Utilizando o helper nativo da arquitetura ──
    const data = safeParseJSON(aiResponse);

    if (!data || !data.items || data.items.length === 0) {
      console.log('[Extrator/Shopping] Nenhum item detectado.');
      return;
    }

    const inserts = data.items.map((i: any) => ({
      user_id: Number(userId),
      item: i.item,
      category: i.category || 'outros',
      done: false
    }));

    const { error } = await supabase.from('shopping_items').insert(inserts);

    if (error) {
      console.error('[Extrator/Shopping] Erro de DB:', error.message);
    } else {
      console.log(`[Extrator/Shopping] Sucesso: ${inserts.length} itens inseridos na lista.`);
    }

  } catch (e) {
    console.error('[Extrator/Shopping] Erro ao extrair itens:', e);
  }
}

export async function extractShoppingLinks(userId: string, userMessage: string): Promise<void> {
  const prompt = `Identifique links de pesquisa ou referências de compra.
  Mensagem: "${userMessage}"
  Retorne JSON: {"links": [{"url": "...", "title": "...", "category": "reforma"}]}
  Categorias: mercado, higiene, farmacia, academia, reforma, casa, roupas, tecnologia, outros.`;

  try {
    const aiResponse = await callAI(prompt, 300);
    const data = JSON.parse(aiResponse);

    for (const link of (data.links || [])) {
      // Upsert nos metadados da categoria
      const { data: existing } = await supabase
        .from('shopping_list_metadata')
        .select('links')
        .eq('user_id', userId)
        .eq('category', link.category)
        .maybeSingle();

      const newLinks = [...(existing?.links || []), { url: link.url, title: link.title }];

      await supabase.from('shopping_list_metadata').upsert({
        user_id: userId,
        category: link.category,
        links: newLinks,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id, category' });
    }
  } catch (e) {
    console.error('[Extrator/Links] Erro:', e);
  }
}
// ── Helper: mapeia categoria PT → slug do banco ──
function mapCategoriaToCategory(cat: string | null): string {
  const map: Record<string, string> = {
    'Saúde':    'health',
    'Trabalho': 'work',
    'Escola':   'school',
    'Família':  'family',
    'Pessoal':  'personal',
    'Rotina':   'personal',
  };
  return map[cat ?? ''] ?? 'personal';
}
