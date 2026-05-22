// lib/diary.ts — V12.1.FULL (Restauração Integral e Blindada)
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
    const raw = await llmGateway.enqueue({
      id: `diary-${userId}-${Date.now()}`,
      priority: 4,
      params: { 
        messages: [{ role: 'user', content: prompt + `\n\n"${userMessage}"` }],
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
    
    // CORREÇÃO: Removida a query de leitura que causava I/O paralelo.
    // O sistema de persistência agora assume o estado através do objeto de payload
    // ou depende da escrita atômica do Supabase.
    
    const payload: any = { 
      user_id: userId, 
      date: today, 
      period, 
      updated_at: new Date().toISOString(),
      content: data.content || null,
      mood: data.mood || null,
      energy: data.energy || null,
      intention: data.intention || null,
      reflection: data.reflection || null,
      gratitude: Array.isArray(data.gratitude) ? data.gratitude : []
    };

    // Escrita direta: O RPC get_consolidated_context trará o dado fresco no próximo turno.
    const { error } = await supabase.from('diary').insert(payload);

    if (!error) await invalidateContextField(Number(userId), 'diary').catch(console.error);
    
    console.log(`[diary] Entrada persistida — user ${userId} | ${period}`);
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
    if (!data.eh_meta || !Array.isArray(data.metas)) return false;

    let hasUpdates = false;
    for (const meta of data.metas) {
      if (!meta.title) continue;

      // Mantemos a query de verificação pois é uma lógica de Upsert necessária
      const { data: existing } = await supabase.from('goals')
        .select('id, progress, steps').eq('user_id', userId).eq('status', 'active')
        .ilike('title', `%${meta.title.slice(0, 20)}%`).maybeSingle();

      if (existing) {
        const patch: any = { updated_at: new Date().toISOString() };
        if (meta.progress !== null && meta.progress > (existing.progress || 0)) patch.progress = meta.progress;
        if (Array.isArray(meta.steps) && (!existing.steps || meta.steps.length > existing.steps.length)) patch.steps = meta.steps;
        if (Object.keys(patch).length > 1) {
          await supabase.from('goals').update(patch).eq('id', existing.id);
          hasUpdates = true;
        }
      } else {
        await supabase.from('goals').insert({
          user_id: userId, title: meta.title, description: meta.description || null,
          due_date: meta.due_date || null, steps: Array.isArray(meta.steps) ? meta.steps : [],
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

// ── GATILHO: ATUALIZAR PROGRESSO ──────────────────────────────────
export async function updateGoalProgress(
  userId: string,
  titleSearch: string,
  progress: number,
  stepLabel?: string
): Promise<string> {
  try {
    const { data: goal } = await supabase
      .from('goals')
      .select('id, title, steps, progress')
      .eq('user_id', userId)
      .eq('status', 'active')
      .ilike('title', `%${titleSearch}%`)
      .maybeSingle();

    if (!goal) return `Meta "${titleSearch}" não encontrada.`;

    const patch: any = { progress, updated_at: new Date().toISOString() };
    if (stepLabel && goal.steps?.length) {
      patch.steps = (goal.steps as any[]).map((s: any) =>
        s.label?.toLowerCase().includes(stepLabel.toLowerCase()) ? { ...s, done: true } : s
      );
    }
    if (progress >= 100) patch.status = 'done';

    await supabase.from('goals').update(patch).eq('id', goal.id);
    await invalidateContextField(Number(userId), 'goals').catch(console.error);

    return progress >= 100 ? `Meta "${goal.title}" concluída! 🎯` : `Progresso de "${goal.title}" atualizado para ${progress}%.`;
  } catch (e) {
    console.error('[goals] Erro updateGoalProgress:', e);
    return 'Erro ao atualizar meta.';
  }
}

// ── BUILDER (Regra 3: Pura e sem I/O) ─────────────────────────────
export function buildDiaryGoalsBlock(masterContext: any): string {
  try {
    const parts: string[] = [];
    const entries = Array.isArray(masterContext?.diary) ? masterContext.diary : [];
    const today = new Date().toISOString().slice(0, 10);
    const todaysEntries = entries.filter((e: any) => e.date === today);
    
    if (todaysEntries.length > 0) {
      parts.push(`[DIÁRIO DE HOJE]\n${todaysEntries.map((e: any) => {
        const b = [
          e.period && e.period !== 'anytime' ? `[${e.period === 'morning' ? 'manhã' : 'noite'}]` : '',
          e.mood ? `humor: ${e.mood}/5` : '',
          e.energy ? `energia: ${e.energy}/5` : '',
          e.intention ? `intenção: ${e.intention}` : '',
          e.reflection ? `reflexão: ${e.reflection}` : '',
          e.content ? e.content : '',
          e.gratitude?.length ? `grato por: ${e.gratitude.join(', ')}` : ''
        ].filter(Boolean).join(' | ');
        return b;
      }).join('\n')}`);
    }

    const goals = Array.isArray(masterContext?.goals) ? masterContext.goals : [];
    if (goals.length > 0) {
      parts.push(`[METAS ATIVAS]\n${goals.map((g: any) => {
        const prazo = g.due_date ? ` — prazo: ${new Date(g.due_date).toLocaleDateString('pt-BR')}` : '';
        const prog = g.progress > 0 ? ` (${g.progress}%)` : '';
        const pend = Array.isArray(g.steps) ? g.steps.filter((s: any) => !s.done).length : 0;
        return `- ${g.title}${prog}${prazo}${pend > 0 ? ` [${pend} pendente${pend > 1 ? 's' : ''}]` : ''}`;
      }).join('\n')}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : '';
  } catch (e) {
    console.error('[buildDiaryGoalsBlock] Erro:', e);
    return '';
  }
}

// ── CHECKER (CronJob - Permite I/O) ──────────────────────────────
export async function checkGoalReminders(userId: string, assistantName: string): Promise<string | null> {
  try {
    const { data: goals } = await supabase.from('goals').select('id, title, due_date, progress, reminder_days')
      .eq('user_id', userId).eq('status', 'active').not('due_date', 'is', null);

    if (!goals?.length) return null;

    const today = new Date();
    const alertas = goals.filter(g => {
      const d = Math.round((new Date(g.due_date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      return (g.reminder_days || [7, 1]).includes(d) && g.progress < 100;
    }).map(g => {
      const d = Math.round((new Date(g.due_date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      return `📌 "${g.title}" vence ${d === 1 ? 'amanhã' : `em ${d} dias`} — ${g.progress}% concluído.`;
    });

    return alertas.length ? `${assistantName} aqui. Lembrete de metas:\n${alertas.join('\n')}` : null;
  } catch (e) {
    console.error('[checkGoalReminders] Erro:', e);
    return null;
  }
}
