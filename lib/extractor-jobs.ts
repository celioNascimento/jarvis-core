// ============================================================
// lib/extractor-jobs.ts — V14.1 (Rigor de Contrato: Tipagem Estrita Resolvida)
// Parte 2: Extratores de Jobs (Apenas Parsing e Delegação)
// ============================================================

import { supabase } from '@/lib/jarvis'; 
import { safeParseJSON } from './Utils/ai-helpers';
import { getCategoryFromType, upsertEvent } from './Utils/db-helpers';
import { familyService } from '@/lib/services/family.service';
import { scheduleReminderOnQStash } from '@/lib/qstash';
import { llmGateway } from '@/lib/chat/llm-gateway';
import { invalidateContextField } from '@/lib/services/context-cache';

// ── TIPAGENS ESTRITAS DE RETORNO DA IA ──────────────────────────────────
interface ExtractedProjetos { projetos?: Array<{ nome: string; tag: string; descricao?: string; status?: string; contexto_tecnico?: string }> }
interface ExtractedEventos { eventos?: Array<{ titulo: string; data: string; tipo: string; recorrente?: boolean; notas?: string }> }
interface ExtractedAgenda { compromissos?: Array<{ descricao: string; data_hora: string; categoria: string; aviso_minutos?: number }> }
interface ExtractedFamilia { esposa?: { nome: string; aniversario?: string }; marido?: { nome: string; aniversario?: string }; filhos?: Array<{ nome: string; nascimento?: string }>; pai?: any; mae?: any; }
interface ExtractedRotina { despertar?: string; dormir?: string; }
interface ExtractedPreferencia { preferencias?: Array<{ tipo: string; descricao: string }> }
interface ExtractedShopping { items?: Array<{ item: string; category?: string }> }
interface ExtractedRecomendacao { recomendacoes?: Array<{ tipo: string; nome: string; status?: string; source?: string }> }

// ── HELPER CENTRAL: LLM Gateway em Background (Agora com Generics) ─────
async function runExtractorAI<T>(userId: string, prompt: string, timeoutMs: number = 15000): Promise<T | null> {
  try {
    const raw = await llmGateway.enqueue({
      id: `extract-job-${userId}-${Date.now()}`,
      priority: 4,
      params: {
        messages: [{ role: 'user', content: prompt }],
        model: 'google/gemini-2.0-flash-001',
        temperature: 0.1,
        timeoutMs
      },
      dedupPayload: prompt.slice(0, 100)
    });
    // O TypeScript agora confia que o JSON devolvido segue a interface T
    return safeParseJSON(raw.content?.replace(/```json|```/gi, '').trim() || '{}') as T;
  } catch (e) {
    console.error('[ExtractorAI] Falha na fila background:', e);
    return null;
  }
}

// ============================================================
// EXTRATOR: PROJETOS
// ============================================================
export async function extractProjeto(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia projetos ou ideias afirmados pelo USUÁRIO. Retorne APENAS JSON:
  Mensagem: "${userMessage}"
  {"projetos": [{"nome": null, "tag": null, "descricao": null, "status": null, "contexto_tecnico": null}]}
  REGRAS: tag em slug. status: "ideia"|"em_desenvolvimento"|"beta"|"producao"|"pausado"`;

  const data = await runExtractorAI<ExtractedProjetos>(userId, prompt, 20000);
  for (const proj of (data?.projetos || [])) {
    if (!proj.nome || !proj.tag) continue;

    const payload: Record<string, any> = { 
      user_id: Number(userId), tag: proj.tag, name: proj.nome, 
      status: proj.status || 'ideia', updated_at: new Date().toISOString() 
    };
    if (proj.descricao) payload.description = proj.descricao;
    if (proj.contexto_tecnico) payload.context_technical = proj.contexto_tecnico;

    await supabase.from('projects').upsert(payload, { onConflict: 'user_id,tag' });
  }
  invalidateContextField(Number(userId), 'projects').catch(() => {});
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
  const prompt = `Extraia eventos. Mensagem: "${userMessage}" Ano: ${anoAtual}
  JSON: {"eventos": [{"titulo": null, "data": "YYYY-MM-DD", "tipo": null, "recorrente": false, "notas": null}]}`;

  const data = await runExtractorAI<ExtractedEventos>(userId, prompt, 15000);
  for (const ev of (data?.eventos || [])) {
    if (!ev.titulo || !ev.data) continue;
    const w = EVENT_WEIGHTS[ev.tipo] || EVENT_WEIGHTS.default;
    await upsertEvent(userId, {
      title: ev.titulo, event_date: ev.data, category: getCategoryFromType(ev.tipo),
      is_recurring: ev.recorrente ?? w.decay_type === 'recurring_annual', notes: ev.notas || null, ...w,
    });
  }
}

// ============================================================
// EXTRATOR: AGENDA (Com Hora) + Lembrete
// ============================================================
export async function extractAgenda(userId: string, userMessage: string): Promise<void> {
  const anoAtual = new Date().getFullYear();
  const prompt = `Extraia compromissos com data e hora explícitas. Mensagem: "${userMessage}"
  JSON: {"compromissos": [{"descricao": null, "data_hora": "ISO8601", "categoria": null, "aviso_minutos": 30}]}
  ANO ATUAL: ${anoAtual}. Exemplo: "sexta às 9h" -> "${anoAtual}-05-08T09:00:00-03:00"`;

  const data = await runExtractorAI<ExtractedAgenda>(userId, prompt, 20000);
  if (!data?.compromissos?.length) return;

  const { data: userData } = await supabase.from('users').select('auth_user_id').eq('id', Number(userId)).single();

  for (const comp of data.compromissos) {
    if (!comp.descricao || !comp.data_hora) continue;

    let dataHora = comp.data_hora;
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
  invalidateContextField(Number(userId), 'events').catch(() => {});
}

// ============================================================
// EXTRATOR: FAMÍLIA
// ============================================================
export async function extractFamilia(userId: string, userMessage: string, gaps: any[]): Promise<void> {
  const prompt = `Extraia dados familiares. Mensagem: "${userMessage}"
  JSON: {"esposa": {"nome": null, "aniversario": null}, "filhos": [{"nome": null, "nascimento": null}], "pai": null, "mae": null}`;

  const data = await runExtractorAI<ExtractedFamilia>(userId, prompt, 20000);
  if (!data) return;

  const profile = await familyService.getCurrentProfile(userId);

  const conjuge = data.esposa?.nome ? data.esposa : data.marido?.nome ? data.marido : null;
  if (conjuge) await familyService.upsertSpouse(userId, conjuge, profile);

  if (data.filhos && Array.isArray(data.filhos)) {
    for (const filho of data.filhos) await familyService.upsertChild(userId, filho);
  }

  if (data.pai) await familyService.upsertParent(userId, data.pai, 'father_name', profile);
  if (data.mae) await familyService.upsertParent(userId, data.mae, 'mother_name', profile);
}

// ============================================================
// EXTRATOR: ROTINA E PREFERÊNCIAS
// ============================================================
export async function extractRotina(userId: string, userMessage: string): Promise<void> {
  const data = await runExtractorAI<ExtractedRotina>(userId, `Extraia rotina. JSON: {"despertar": null, "dormir": null} Msg: "${userMessage}"`, 10000);
  if (!data) return;

  const parts = [data.despertar ? `Despertar: ${data.despertar}` : '', data.dormir ? `Dormir: ${data.dormir}` : ''].filter(Boolean);
  if (!parts.length) return;

  const { data: prof } = await supabase.from('user_profiles').select('personality_notes').eq('user_id', Number(userId)).maybeSingle();
  const updated = /\[ROTINA\]/i.test(prof?.personality_notes || '') ? (prof?.personality_notes || '').replace(/\[ROTINA\][^\n]*/i, `[ROTINA] ${parts.join(' | ')}`) : `${prof?.personality_notes || ''}\n[ROTINA] ${parts.join(' | ')}`.trim();

  await supabase.from('user_profiles').upsert({ user_id: Number(userId), personality_notes: updated, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  invalidateContextField(Number(userId), 'profile').catch(() => {});
}

export async function extractPreferencia(userId: string, userMessage: string): Promise<void> {
  const data = await runExtractorAI<ExtractedPreferencia>(userId, `Extraia preferências. JSON: {"preferencias": [{"tipo": "lugar", "descricao": "X"}]} Msg: "${userMessage}"`, 15000);
  const prefs = data?.preferencias || [];
  if (!prefs.length) return;

  const { data: prof } = await supabase.from('user_profiles').select('career_notes').eq('user_id', Number(userId)).maybeSingle();
  const newLine = prefs.map((p: any) => `[${p.tipo}] ${p.descricao}`).join(' | ');
  if (prefs.every((p: any) => (prof?.career_notes || '').includes(p.descricao))) return;

  await supabase.from('user_profiles').upsert({ user_id: Number(userId), career_notes: prof?.career_notes ? `${prof.career_notes} | ${newLine}` : newLine, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  invalidateContextField(Number(userId), 'profile').catch(() => {});
}

// ============================================================
// EXTRATOR: COMPRAS & RECOMENDAÇÕES
// ============================================================
export async function extractShopping(userId: string, userMessage: string, aiReply: string = ''): Promise<void> {
  const prompt = `Extraia itens de compra. JSON: {"items": [{"item": "nome", "category": "mercado"}]} Msg: "${userMessage}" IA: "${aiReply}"`;
  const data = await runExtractorAI<ExtractedShopping>(userId, prompt, 15000);
  if (data?.items?.length) {
    const inserts = data.items.map(i => ({ user_id: Number(userId), item: i.item, category: i.category || 'outros', done: false }));
    await supabase.from('shopping_items').insert(inserts);
    invalidateContextField(Number(userId), 'shopping').catch(() => {});
  }
}

export async function extractRecomendacao(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia recomendações. JSON: {"recomendacoes": [{"tipo": "lugar", "nome": "X", "status": "pending"}]} Msg: "${userMessage}" IA: "${aiReply}"`;
  const data = await runExtractorAI<ExtractedRecomendacao>(userId, prompt, 15000);
  
  for (const rec of (data?.recomendacoes || [])) {
    if (!rec.nome || !rec.tipo) continue;
    const { data: existing } = await supabase.from('recommendations').select('id, status').eq('user_id', Number(userId)).eq('type', rec.tipo).ilike('name', rec.nome).maybeSingle();

    if (existing) {
      if (rec.status !== 'pending' && existing.status === 'pending') {
        await supabase.from('recommendations').update({ status: rec.status, updated_at: new Date().toISOString() }).eq('id', existing.id);
      }
    } else {
      await supabase.from('recommendations').insert({ user_id: Number(userId), type: rec.tipo, name: rec.nome, source: rec.source || 'jarvis', status: rec.status || 'pending' });
    }
  }
  invalidateContextField(Number(userId), 'recommendations').catch(() => {});
}

// ============================================================
// LOADERS DO SYSTEM PROMPT (Puros! Sem I/O de Banco)
// ============================================================

export function buildRecommendationsBlock(masterContext: any): string {
  const recs = masterContext?.recommendations || [];
  if (!recs.length) return '';
  
  const valid = recs.filter((r: any) => r.status !== 'disliked').slice(0, 30);
  if (!valid.length) return '';

  const lines = valid.map((r: any) => `- [${r.type}] ${r.name} (${r.source})`);
  return `[RECOMENDAÇÕES]\n${lines.join('\n')}`;
}

export function buildTopicBlock(masterContext: any): string {
  const topics = masterContext?.topics || [];
  if (!topics.length) return '';

  const lines = topics.slice(0, 5).map((t: any) => `- [${t.label}] ${t.topic}`);
  return `[TÓPICOS RECORRENTES]\n${lines.join('\n')}`;
}