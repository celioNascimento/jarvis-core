// lib/diary.ts
// Motor de diário pessoal e metas — Lev Platform
// V12.1 — Refatorado para o Contrato de 4 Regras + Prevenção de Erros de Parse

import { supabase } from '@/lib/jarvis';
import { llmGateway } from '@/lib/chat/llm-gateway'; // [CONTRATO: REGRA 4]
import { invalidateContextField } from '@/lib/services/context-cache'; // [CONTRATO: REGRA 2]

// ============================================================
// EXTRATOR: DIÁRIO — detecta e persiste entrada do dia
// ============================================================
export async function extractDiary(
  userId: string,
  userMessage: string,
  period: 'morning' | 'evening' | 'anytime' = 'anytime'
): Promise<boolean> {
  const prompt = `Analise a mensagem e extraia dados de diário pessoal se houver.

Mensagem: "${userMessage}"

Retorne APENAS JSON (null para não mencionados):
{
  "eh_diario": true,
  "content": null,
  "mood": null,
  "energy": null,
  "gratitude": [],
  "intention": null,
  "reflection": null
}

REGRAS:
- eh_diario: true se a mensagem for relato pessoal do dia, reflexão, gratidão, humor ou intenção
- content: texto livre do relato — resumo objetivo em 1-2 frases do que foi dito
- mood: 1-5 inferido do tom (1=muito mal, 3=neutro, 5=ótimo). null se não der para inferir
- energy: 1-5 inferido (1=esgotado, 5=cheio de energia). null se não der para inferir
- gratitude: até 3 itens mencionados com gratidão. [] se nenhum
- intention: intenção ou foco do dia se for mensagem matinal
- reflection: reflexão ou aprendizado se for mensagem noturna
- eh_diario: false se for pergunta, tarefa, agenda ou assunto técnico`;

  try {
    // [CONTRATO: REGRA 4] Substituição do ai-helpers pelo Gateway
    const raw = await llmGateway.enqueue({
        id: `diary-${userId}-${Date.now()}`,
        priority: 4,
        params: {
            messages: [{ role: 'user', content: prompt + `\n\nMensagem: "${userMessage}"` }],
            model: 'google/gemini-2.0-flash-001',
            temperature: 0.2,
            timeoutMs: 15000
        },
        dedupPayload: userMessage.slice(0, 50)
    });
    
    if (!raw.content) return false;

    // Regex blindada: impede quebras de linha que causem erros de Unterminated literal
    const data = JSON.parse(raw.content.replace(/[`]{3}json|[`]{3}/gi, '').trim());

    if (!data.eh_diario) return false;
    if (!data.content && !data.mood && !data.intention && !data.reflection) return false;

    const today = new Date().toISOString().slice(0, 10);

    const { data: existing } = await supabase
      .from('diary')
      .select('id, content, gratitude')
      .eq('user_id', userId)
      .eq('date', today)
      .eq('period', period)
      .maybeSingle();

    const payload: Record<string, any> = {
      user_id: userId,
      date: today,
      period,
      updated_at: new Date().toISOString(),
    };

    // CORREÇÃO: Crases de template string perfeitamente alinhadas
    if (data.content) {
      payload.content = existing?.content
        ? `${existing.content}\n${data.content}`
        : data.content;
    }
    
    if (data.mood)        payload.mood       = data.mood;
    if (data.energy)      payload.energy     = data.energy;
    if (data.intention)   payload.intention  = data.intention;
    if (data.reflection)  payload.reflection = data.reflection;

    if (data.gratitude?.length) {
      const existing_g: string[] = existing?.gratitude || [];
      payload.gratitude = [...new Set([...existing_g, ...data.gratitude])].slice(0, 3);
    }

    let error;
    if (existing?.id) {
      ({ error } = await supabase.from('diary').update(payload).eq('id', existing.id));
    } else {
      ({ error } = await supabase.from('diary').insert(payload));
    }

    // [CONTRATO: REGRA 2] Invalidação de Cache no final de toda escrita
    if (!error) {
      await invalidateContextField(Number(userId), 'diary').catch(console.error);
    }

    console.log(`[diary] Entrada salva — user ${userId} | ${period} | mood: ${data.mood}`);
    return true;
  } catch (e) {
    console.error('[diary] Erro:', e);
    return false;
  }
}

// ============================================================
// EXTRATOR: METAS — detecta e persiste metas pessoais
// ============================================================
export async function extractGoal(
  userId: string,
  userMessage: string
): Promise<boolean> {
  const prompt = `Analise a mensagem e extraia metas pessoais se houver.
Mensagem: "${userMessage}"
Retorne APENAS JSON:
{ "eh_meta": false, "metas": [{ "title": null, "description": null, "due_date": null, "steps": [], "project_tag": null, "progress": null }] }`;

  try {
    // [CONTRATO: REGRA 4] Substituição do ai-helpers pelo Gateway
    const raw = await llmGateway.enqueue({
        id: `goal-${userId}-${Date.now()}`,
        priority: 4,
        params: {
            messages: [{ role: 'user', content: prompt }],
            model: 'google/gemini-2.0-flash-001',
            temperature: 0.2,
            timeoutMs: 20000
        },
        dedupPayload: userMessage.slice(0, 50)
    });
    
    const data = JSON.parse(raw.content?.replace(/[`]{3}json|[`]{3}/gi, '').trim() || '{}');

    if (!data.eh_meta || !data.metas?.length) return false;

    let hasUpdates = false;

    for (const meta of data.metas) {
      if (!meta.title) continue;

      const { data: existing } = await supabase
        .from('goals')
        .select('id, progress, steps')
        .eq('user_id', userId)
        .eq('status', 'active')
        .ilike('title', `%${meta.title.slice(0, 20)}%`)
        .maybeSingle();

      if (existing) {
        const patch: Record<string, any> = { updated_at: new Date().toISOString() };
        if (meta.progress !== null && meta.progress > (existing.progress || 0)) {
          patch.progress = meta.progress;
        }
        if (meta.steps?.length && (!existing.steps || meta.steps.length > existing.steps.length)) {
          patch.steps = meta.steps;
        }
        if (Object.keys(patch).length > 1) {
          await supabase.from('goals').update(patch).eq('id', existing.id);
          console.log(`[goals] Atualizada: ${meta.title}`);
          hasUpdates = true;
        }
        continue;
      }

      await supabase.from('goals').insert({
        user_id:       userId,
        title:         meta.title,
        description:   meta.description || null,
        due_date:      meta.due_date || null,
        steps:         meta.steps || [],
        project_tag:   meta.project_tag || null,
        progress:      meta.progress || 0,
        reminder_days: [7, 1],
        status:        'active',
      });
      console.log(`[goals] Nova meta: ${meta.title}`);
      hasUpdates = true;
    }

    // [CONTRATO: REGRA 2] Invalidação de Cache
    if (hasUpdates) {
       await invalidateContextField(Number(userId), 'goals').catch(console.error);
    }
    
    return true;
  } catch (e) {
    console.error('[goals] Erro:', e);
    return false;
  }
}

// ============================================================
// GATILHO: atualiza progresso de meta via comando direto
// ============================================================
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

    const patch: Record<string, any> = {
      progress,
      updated_at: new Date().toISOString(),
    };

    if (stepLabel && goal.steps?.length) {
      patch.steps = (goal.steps as any[]).map((s: any) =>
        s.label?.toLowerCase().includes(stepLabel.toLowerCase())
          ? { ...s, done: true }
          : s
      );
    }

    if (progress >= 100) patch.status = 'done';

    await supabase.from('goals').update(patch).eq('id', goal.id);

    // [CONTRATO: REGRA 2] Invalidação de Cache
    await invalidateContextField(Number(userId), 'goals').catch(console.error);

    return progress >= 100
      ? `Meta "${goal.title}" concluída! 🎯`
      : `Progresso de "${goal.title}" atualizado para ${progress}%.`;
  } catch (e) {
    console.error('[goals] Erro updateGoalProgress:', e);
    return 'Erro ao atualizar meta.';
  }
}

// ============================================================
// BUILDER: bloco de diário + metas para o system prompt
// REGRA 3: LÊ APENAS DO CONTEXTO MESTRE. ZERO QUERIES.
// ============================================================
export function buildDiaryGoalsBlock(masterContext: any): string {
  try {
    const parts: string[] = [];

    // O masterContext.diary já traz as últimas entradas (resolvido pelo RPC)
    const entries = masterContext?.diary || [];
    if (entries.length > 0) {
      // Pega apenas a entrada de hoje se existir
      const today = new Date().toISOString().slice(0, 10);
      const todaysEntries = entries.filter((e: any) => e.date === today);
      
      if (todaysEntries.length > 0) {
          const lines = todaysEntries.map((e: any) => {
            const bits: string[] = [];
            if (e.period && e.period !== 'anytime') bits.push(`[${e.period === 'morning' ? 'manhã' : 'noite'}]`);
            if (e.mood)       bits.push(`humor: ${e.mood}/5`);
            if (e.energy)     bits.push(`energia: ${e.energy}/5`);
            if (e.intention)  bits.push(`intenção: ${e.intention}`);
            if (e.reflection) bits.push(`reflexão: ${e.reflection}`);
            if (e.content)    bits.push(e.content);
            if (e.gratitude?.length) bits.push(`grato por: ${e.gratitude.join(', ')}`);
            return bits.join(' | ');
          });
          parts.push(`[DIÁRIO DE HOJE]\n${lines.join('\n')}`);
      }
    }

    // Parse de Metas Ativas (Se injetado futuramente)
    const goals = masterContext?.goals || [];
    if (goals.length > 0) {
      const lines = goals.map((g: any) => {
        const prazo = g.due_date
          ? ` — prazo: ${new Date(g.due_date).toLocaleDateString('pt-BR')}`
          : '';
        const prog  = g.progress > 0 ? ` (${g.progress}%)` : '';
        const etapas = (g.steps || []).filter((s: any) => !s.done).length;
        const etapasTxt = etapas > 0
          ? ` [${etapas} etapa${etapas > 1 ? 's' : ''} pendente${etapas > 1 ? 's' : ''}]`
          : '';
        return `- ${g.title}${prog}${prazo}${etapasTxt}`;
      });
      parts.push(`[METAS ATIVAS]\n${lines.join('\n')}`);
    }

    return parts.join('\n\n');
  } catch (e) {
    console.error('[buildDiaryGoalsBlock] Erro:', e);
    return '';
  }
}

// ============================================================
// CHECKER: lembretes de metas próximas do prazo
// Chamado pelo cron check-events
// ============================================================
export async function checkGoalReminders(
  userId: string,
  assistantName: string
): Promise<string | null> {
  // Esse pode bater no banco, pois roda em CronJob, não no fluxo do chat
  try {
    const { data: goals } = await supabase
      .from('goals')
      .select('id, title, due_date, progress, reminder_days')
      .eq('user_id', userId)
      .eq('status', 'active')
      .not('due_date', 'is', null);

    if (!goals?.length) return null;

    const today = new Date();
    const alertas: string[] = [];

    for (const goal of goals) {
      const daysUntil = Math.round(
        (new Date(goal.due_date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
      );
      const reminderDays: number[] = goal.reminder_days || [7, 1];

      if (reminderDays.includes(daysUntil) && goal.progress < 100) {
        const when = daysUntil === 1 ? 'amanhã' : `em ${daysUntil} dias`;
        alertas.push(`📌 "${goal.title}" vence ${when} — ${goal.progress}% concluído.`);
      }
    }

    if (alertas.length === 0) return null;

    return `${assistantName} aqui. Lembrete de metas:\n${alertas.join('\n')}`;
  } catch (e) {
    console.error('[checkGoalReminders] Erro:', e);
    return null;
  }
}
