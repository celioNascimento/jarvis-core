// lib/diary.ts — V12.1.R (Restauração Integral e Blindada)
import { supabase } from '@/lib/jarvis';
import { llmGateway } from '@/lib/chat/llm-gateway';
import { invalidateContextField } from '@/lib/services/context-cache';

// ── EXTRATOR: DIÁRIO ──────────────────────────────────────────────
export async function extractDiary(
  userId: string,
  userMessage: string,
  period: 'morning' | 'evening' | 'anytime' = 'anytime'
): Promise<boolean> {
  const prompt = `Analise a mensagem e extraia dados de diário pessoal se houver.
Mensagem: "${userMessage}"
Retorne APENAS JSON (null para não mencionados):
{ "eh_diario": boolean, "content": string|null, "mood": number|null, "energy": number|null, "gratitude": string[], "intention": string|null, "reflection": string|null }
REGRAS: eh_diario é true para relatos, humor, gratidão, intenção ou reflexão.`;

  try {
    // Regra 4: Uso do Gateway (Prioridade 4 = background)
    const raw = await llmGateway.enqueue({
      id: `diary-${userId}-${Date.now()}`,
      priority: 4,
      params: { 
        messages: [{ role: 'user', content: prompt }],
        model: 'google/gemini-2.0-flash-001',
        temperature: 0.2,
        timeoutMs: 15000 
      },
      dedupPayload: `${userId}-${userMessage.slice(0, 50)}`
    });

    if (!raw.content) return false;
    const data = JSON.parse(raw.content.replace(/[`]{3}json|[`]{3}/gi, '').trim());

    if (!data.eh_diario || (!data.content && !data.mood && !data.intention && !data.reflection)) return false;

    const today = new Date().toISOString().slice(0, 10);
    const { data: existing } = await supabase.from('diary')
      .select('id, content, gratitude').eq('user_id', userId).eq('date', today).eq('period', period).maybeSingle();

    const payload: any = { user_id: userId, date: today, period, updated_at: new Date().toISOString() };
    
    if (data.content) payload.content = existing?.content ? `${existing.content}\n${data.content}` : data.content;
    if (data.mood) payload.mood = data.mood;
    if (data.energy) payload.energy = data.energy;
    if (data.intention) payload.intention = data.intention;
    if (data.reflection) payload.reflection = data.reflection;

    if (data.gratitude?.length) {
      const existing_g: string[] = existing?.gratitude || [];
      payload.gratitude = [...new Set([...existing_g, ...data.gratitude])].slice(0, 3);
    }

    const { error } = existing?.id 
      ? await supabase.from('diary').update(payload).eq('id', existing.id)
      : await supabase.from('diary').insert(payload);

    // Regra 2: Invalidação de Cache (Obrigatória)
    if (!error) await invalidateContextField(Number(userId), 'diary').catch(console.error);
    
    console.log(`[diary] Entrada salva — user ${userId} | ${period} | mood: ${data.mood}`);
    return !error;
  } catch (e) {
    console.error('[diary] Erro:', e);
    return false;
  }
}

// ── EXTRATOR: METAS ──────────────────────────────────────────────
export async function extractGoal(userId: string, userMessage: string): Promise<boolean> {
  const prompt = `Analise a mensagem e extraia metas pessoais. Retorne JSON: { "eh_meta": boolean, "metas": [...] }`;

  try {
    const raw = await llmGateway.enqueue({
      id: `goal-${userId}-${Date.now()}`,
      priority: 4,
      params: { messages: [{ role: 'user', content: prompt + `\n\n"${userMessage}"` }], model: 'google/gemini-2.0-flash-001', temperature: 0.2, timeoutMs: 20000 },
      dedupPayload: ''
    });

    const data = JSON.parse(raw.content?.replace(/[`]{3}json|[`]{3}/gi, '').trim() || '{}');
    if (!data.eh_meta || !data.metas?.length) return false;

    let hasUpdates = false;
    for (const meta of data.metas) {
      if (!meta.title) continue;

      const { data: existing } = await supabase.from('goals')
        .select('id, progress, steps').eq('user_id', userId).eq('status', 'active')
        .ilike('title', `%${meta.title.slice(0, 20)}%`).maybeSingle();

      if (existing) {
        const patch: any = { updated_at: new Date().toISOString() };
        if (meta.progress !== null && meta.progress > (existing.progress || 0)) patch.progress = meta.progress;
        if (meta.steps?.length && (!existing.steps || meta.steps.length > existing.steps.length)) patch.steps = meta.steps;
        if (Object.keys(patch).length > 1) {
          await supabase.from('goals').update(patch).eq('id', existing.id);
          hasUpdates = true;
        }
      } else {
        await supabase.from('goals').insert({
          user_id: userId, title: meta.title, description: meta.description || null,
          due_date: meta.due_date || null, steps: meta.steps || [],
          project_tag: meta.project_tag || null, progress: meta.progress || 0,
          reminder_days: [7, 1], status: 'active'
        });
        hasUpdates = true;
      }
    }

    if (hasUpdates) await invalidateContextField(Number(userId), 'goals').catch(console.error);
    return true;
  } catch (e) {
    console.error('[goals] Erro:', e);
    return false;
  }
}

// ── BUILDER (Regra 3: Pura e sem I/O) ─────────────────────────────
export function buildDiaryGoalsBlock(masterContext: any): string {
  try {
    const parts: string[] = [];
    const entries = masterContext?.diary || [];
    const today = new Date().toISOString().slice(0, 10);
    const todaysEntries = entries.filter((e: any) => e.date === today);
    
    if (todaysEntries.length > 0) {
      parts.push(`[DIÁRIO DE HOJE]\n${todaysEntries.map((e: any) => {
        const bits = [
          e.period !== 'anytime' ? `[${e.period === 'morning' ? 'manhã' : 'noite'}]` : '',
          e.mood ? `humor: ${e.mood}/5` : '',
          e.energy ? `energia: ${e.energy}/5` : '',
          e.intention ? `intenção: ${e.intention}` : '',
          e.reflection ? `reflexão: ${e.reflection}` : '',
          e.content ? e.content : '',
          e.gratitude?.length ? `grato por: ${e.gratitude.join(', ')}` : ''
        ].filter(Boolean).join(' | ');
        return bits;
      }).join('\n')}`);
    }

    const goals = masterContext?.goals || [];
    if (goals.length > 0) {
      parts.push(`[METAS ATIVAS]\n${goals.map((g: any) => {
        const prazo = g.due_date ? ` — prazo: ${new Date(g.due_date).toLocaleDateString('pt-BR')}` : '';
        const prog = g.progress > 0 ? ` (${g.progress}%)` : '';
        const etapas = (g.steps || []).filter((s: any) => !s.done).length;
        const etapasTxt = etapas > 0 ? ` [${etapas} etapa${etapas > 1 ? 's' : ''} pendente${etapas > 1 ? 's' : ''}]` : '';
        return `- ${g.title}${prog}${prazo}${etapasTxt}`;
      }).join('\n')}`);
    }

    return parts.join('\n\n');
  } catch (e) {
    console.error('[buildDiaryGoalsBlock] Erro:', e);
    return '';
  }
}

// ── CHECKER (CronJob - Permitido I/O) ────────────────────────────
export async function checkGoalReminders(userId: string, assistantName: string): Promise<string | null> {
  try {
    const { data: goals } = await supabase.from('goals').select('id, title, due_date, progress, reminder_days')
      .eq('user_id', userId).eq('status', 'active').not('due_date', 'is', null);

    if (!goals?.length) return null;

    const today = new Date();
    const alertas = goals.filter(g => {
      const daysUntil = Math.round((new Date(g.due_date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      return (g.reminder_days || [7, 1]).includes(daysUntil) && g.progress < 100;
    }).map(g => {
      const daysUntil = Math.round((new Date(g.due_date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      return `📌 "${g.title}" vence ${daysUntil === 1 ? 'amanhã' : `em ${daysUntil} dias`} — ${g.progress}% concluído.`;
    });

    return alertas.length ? `${assistantName} aqui. Lembrete de metas:\n${alertas.join('\n')}` : null;
  } catch (e) {
    console.error('[checkGoalReminders] Erro:', e);
    return null;
  }
}
