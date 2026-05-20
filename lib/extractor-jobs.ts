// ============================================================
// lib/extractor-jobs.ts
// Parte 2: Extratores de Jobs (Apenas Parsing e Delegação)
// ============================================================

import { supabase } from '@/lib/jarvis'; // Usa seu client central
import { callAIExtractor, safeParseJSON } from './Utils/ai-helpers';
import { getCategoryFromType, upsertEvent } from './Utils/db-helpers';
import { familyService } from '@/lib/services/family.service';
import { scheduleReminderOnQStash } from '@/lib/qstash';

// ============================================================
// EXTRATOR: PROJETOS
// ============================================================
export async function extractProjeto(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia projetos ou ideias afirmados pelo USUÁRIO. Retorne APENAS JSON:
  Mensagem do usuário: "${userMessage}"
  {"projetos": [{"nome": null, "tag": null, "descricao": null, "status": null, "contexto_tecnico": null}]}
  REGRAS:
  - tag: slug lowercase sem espacos. USE a SIGLA quando houver: "PQF (Procuro Quem Faca)" -> tag="pqf"
  - status: "ideia"|"em_desenvolvimento"|"beta"|"producao"|"pausado"`;

  try {
    const data = safeParseJSON(await callAIExtractor(prompt, 300));
    for (const proj of (data?.projetos || [])) {
      if (!proj.nome || !proj.tag) continue;

      const { data: existing } = await supabase.from('projects')
        .select('description, context_technical, status')
        .eq('user_id', userId).eq('tag', proj.tag).maybeSingle();

      const payload: Record<string, any> = { user_id: userId, tag: proj.tag, name: proj.nome, updated_at: new Date().toISOString() };
      if (proj.descricao && (!existing?.description || proj.descricao.length > existing.description.length)) payload.description = proj.descricao;
      if (proj.contexto_tecnico && !existing?.context_technical) payload.context_technical = proj.contexto_tecnico;
      if (proj.status) payload.status = proj.status;

      await supabase.from('projects').upsert(payload, { onConflict: 'user_id,tag' });
    }
  } catch (e) { console.error('[Extrator/projeto] Erro:', e); }
}

// ============================================================
// EXTRATOR: EVENTOS GENÉRICOS (Sem Hora)
// ============================================================
const EVENT_WEIGHTS: Record<string, { priority: string; decay_type: string; emotional_weight: number }> = {
  aniversario_proprio: { priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 1.00 },
  aniversario_esposa: { priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 0.95 },
  aniversario_filho: { priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 0.90 },
  natal: { priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 0.85 },
  default: { priority: 'media', decay_type: 'one_time', emotional_weight: 0.50 },
};

export async function extractEvento(userId: string, userMessage: string): Promise<void> {
  const anoAtual = new Date().getFullYear();
  const prompt = `Extraia eventos/datas comemorativas mencionados. Mensagem: "${userMessage}"
  Retorne APENAS JSON: {"eventos": [{"titulo": null, "data": "YYYY-MM-DD", "tipo": null, "recorrente": false, "notas": null}]}
  Ano corrente: ${anoAtual}`;

  try {
    const data = safeParseJSON(await callAIExtractor(prompt, 300));
    for (const ev of (data?.eventos || [])) {
      if (!ev.titulo || !ev.data) continue;
      const w = EVENT_WEIGHTS[ev.tipo] || EVENT_WEIGHTS.default;

      await upsertEvent(userId, {
        title: ev.titulo, event_date: ev.data, category: getCategoryFromType(ev.tipo),
        is_recurring: ev.recorrente ?? w.decay_type === 'recurring_annual', notes: ev.notas || null, ...w,
      });
    }
  } catch (e) { console.error('[Extrator/evento] Erro:', e); }
}

// ============================================================
// EXTRATOR: AGENDA (Com Hora) + Lembrete
// ============================================================
export async function extractAgenda(userId: string, userMessage: string): Promise<void> {
  const anoAtual = new Date().getFullYear();
  const prompt = `Extraia compromissos com data E hora explícitas. Mensagem: "${userMessage}"
  Retorne APENAS JSON: {"compromissos": [{"descricao": null, "data_hora": "ISO8601", "categoria": null, "aviso_minutos": 30}]}
  ANO ATUAL: ${anoAtual}. Exemplo: "sexta às 9h" -> "${anoAtual}-05-08T09:00:00-03:00"`;

  try {
    const data = safeParseJSON(await callAIExtractor(prompt, 250));
    const { data: userData } = await supabase.from('users').select('auth_user_id').eq('id', userId).single();

    for (const comp of (data?.compromissos || [])) {
      if (!comp.descricao || !comp.data_hora) continue;

      let dataHora = comp.data_hora as string;
      if (parseInt(dataHora.substring(0, 4)) < anoAtual) dataHora = String(anoAtual) + dataHora.substring(4);

      const startAt = new Date(dataHora);
      if (isNaN(startAt.getTime())) continue;

      const { error: evError } = await supabase.schema('jarvis').from('events').insert({
        user_id: Number(userId), title: comp.descricao, start_at: startAt.toISOString(),
        end_at: new Date(startAt.getTime() + 3600000).toISOString(), all_day: false,
        category: getCategoryFromType(comp.categoria), source: 'lev', reminder_minutes: [comp.aviso_minutos ?? 30],
      });

      if (!evError && userData?.auth_user_id) {
        const notifyTime = new Date(startAt.getTime() - (comp.aviso_minutos ?? 30) * 60000).toISOString();
        if (new Date(notifyTime).getTime() > Date.now()) {
          const { data: reminder } = await supabase.schema('jarvis').from('reminders').insert({
            user_id: Number(userId), title: `📅 ${comp.descricao}`, type: 'agenda', scheduled_time: notifyTime,
            status: 'pending', metadata: { auth_user_id: userData.auth_user_id },
          }).select('id').single();

          if (reminder) {
            const qstashId = await scheduleReminderOnQStash({
              reminderId: String(reminder.id), userId, authUserId: userData.auth_user_id,
              message: `📅 [Agenda] ${comp.descricao}`, scheduledTime: notifyTime,
            });
            if (qstashId) await supabase.schema('jarvis').from('reminders').update({ qstash_message_id: qstashId }).eq('id', reminder.id);
          }
        }
      }
    }
  } catch (e) { console.error('[Extrator/agenda] Erro:', e); }
}

// ============================================================
// EXTRATOR: FAMÍLIA (Delega para o Serviço)
// ============================================================
export async function extractFamilia(userId: string, userMessage: string, gaps: any[]): Promise<void> {
  const prompt = `Extraia dados familiares afirmados explicitamente pelo USUÁRIO. Mensagem: "${userMessage}"
  Retorne APENAS JSON (null para não mencionados):
  {"esposa": {"nome": null, "aniversario": null}, "filhos": [{"nome": null, "nascimento": null}], "pai": null, "mae": null}`;

  // DECLARAÇÃO FORA DO TRY
  const profile = await familyService.getCurrentProfile(userId);

  try {
    const raw = await callAIExtractor(prompt, 500);
    const data = safeParseJSON(raw);
    if (!data) return;

    // Cônjuge
    const conjuge = data.esposa?.nome ? data.esposa : data.marido?.nome ? data.marido : null;
    if (conjuge) {
      await familyService.upsertSpouse(userId, conjuge, profile);
    }

    // Filhos
    if (data.filhos && Array.isArray(data.filhos)) {
      for (const filho of data.filhos) {
        await familyService.upsertChild(userId, filho);
      }
    }

    // Pais
    if (data.pai) await familyService.upsertParent(userId, data.pai, 'father_name', profile);
    if (data.mae) await familyService.upsertParent(userId, data.mae, 'mother_name', profile);

  } catch (e) {
    console.error('[Extrator/Familia] Erro:', e);
  }
}


// ============================================================
// EXTRATOR: ROTINA E PREFERÊNCIAS
// ============================================================
export async function extractRotina(userId: string, userMessage: string): Promise<void> {
  try {
    const data = safeParseJSON(await callAIExtractor(`Extraia dados de rotina. JSON: {"despertar": null, "dormir": null} Mensagem: "${userMessage}"`, 200));
    if (!data) return;

    const parts = [data.despertar ? `Despertar: ${data.despertar}` : '', data.dormir ? `Dormir: ${data.dormir}` : ''].filter(Boolean);
    if (!parts.length) return;

    const { data: prof } = await supabase.from('user_profiles').select('personality_notes').eq('user_id', userId).maybeSingle();
    const updated = /\[ROTINA\]/i.test(prof?.personality_notes || '') ? (prof?.personality_notes || '').replace(/\[ROTINA\][^\n]*/i, `[ROTINA] ${parts.join(' | ')}`) : `${prof?.personality_notes || ''}\n[ROTINA] ${parts.join(' | ')}`.trim();

    await supabase.from('user_profiles').upsert({ user_id: userId, personality_notes: updated, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  } catch (e) { console.error('[Extrator/rotina] Erro:', e); }
}

export async function extractPreferencia(userId: string, userMessage: string): Promise<void> {
  try {
    const data = safeParseJSON(await callAIExtractor(`Extraia preferências. JSON: {"preferencias": [{"tipo": "lugar", "descricao": "X"}]} Mensagem: "${userMessage}"`, 200));
    const prefs = data?.preferencias || [];
    if (!prefs.length) return;

    const { data: prof } = await supabase.from('user_profiles').select('career_notes').eq('user_id', userId).maybeSingle();
    const newLine = prefs.map((p: any) => `[${p.tipo}] ${p.descricao}`).join(' | ');
    if (prefs.every((p: any) => (prof?.career_notes || '').includes(p.descricao))) return;

    await supabase.from('user_profiles').upsert({ user_id: userId, career_notes: prof?.career_notes ? `${prof.career_notes} | ${newLine}` : newLine, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  } catch (e) { console.error('[Extrator/preferencia] Erro:', e); }
}

// ============================================================
// EXTRATOR: COMPRAS
// ============================================================
export async function extractShopping(userId: string, userMessage: string, aiReply: string = ''): Promise<void> {
  const prompt = `Extraia itens de compra. JSON: {"items": [{"item": "nome", "category": "mercado"}]} Mensagem: "${userMessage}" IA: "${aiReply}"`;
  try {
    const data = safeParseJSON(await callAIExtractor(prompt, 300));
    if (data?.items?.length) {
      const inserts = data.items.map((i: any) => ({ user_id: Number(userId), item: i.item, category: i.category || 'outros', done: false }));
      await supabase.from('shopping_items').insert(inserts);
    }
  } catch (e) { console.error('[Extrator/Shopping] Erro:', e); }
}

export async function extractRecomendacao(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia recomendações. JSON: {"recomendacoes": [{"tipo": "lugar", "nome": "X", "status": "pending"}]} Mensagem: "${userMessage}" IA: "${aiReply}"`;
  try {
    const data = safeParseJSON(await callAIExtractor(prompt, 400));
    for (const rec of (data?.recomendacoes || [])) {
      if (!rec.nome || !rec.tipo) continue;
      const { data: existing } = await supabase.from('recommendations').select('id, status').eq('user_id', userId).eq('type', rec.tipo).ilike('name', rec.nome).maybeSingle();

      if (existing) {
        if (rec.status !== 'pending' && existing.status === 'pending') await supabase.from('recommendations').update({ status: rec.status, updated_at: new Date().toISOString() }).eq('id', existing.id);
      } else {
        await supabase.from('recommendations').insert({ user_id: userId, type: rec.tipo, name: rec.nome, source: rec.source || 'jarvis', status: rec.status || 'pending' });
      }
    }
  } catch (e) { console.error('[Extrator/recomendacao] Erro:', e); }
}

// ============================================================
// LOADERS DO SYSTEM PROMPT (Devem ser migrados p/ masterContext futuramente)
// ============================================================
export async function buildRecommendationsBlock(userId: string, messageText: string): Promise<string> {
  const { data: recs } = await supabase.from('recommendations').select('type, name, source, status').eq('user_id', userId).neq('status', 'disliked').limit(30);
  if (!recs?.length) return '';
  const lines = recs.map((r: any) => `- [${r.type}] ${r.name} (${r.source})`);
  return `[RECOMENDAÇÕES]\n${lines.join('\n')}`;
}

export async function buildTopicBlock(userId: string, messageText: string): Promise<string> {
  const { data: topics } = await supabase.from('topic_index').select('topic, label').eq('user_id', userId).order('entry_count', { ascending: false }).limit(5);
  if (!topics?.length) return '';
  return `[TÓPICOS RECORRENTES]\n${topics.map((t: any) => `- [${t.label}] ${t.topic}`).join('\n')}`;
}