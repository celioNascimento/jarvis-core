// lib/services/tdah.service.ts
// V1.0.0 — Fonte Única da Verdade (SSOT) para Foco e TDAH

import { supabase } from '@/lib/jarvis';

// ─── 1. BRAIN DUMPS (Despejo Mental) ──────────────────────────────────────────
export async function coreCreateBrainDump(userId: number, payload: { text: string; category?: string }) {
  const { data, error } = await supabase
    .schema('jarvis')
    .from('brain_dumps')
    .insert({ 
      user_id: userId, 
      text: payload.text, 
      category: payload.category 
    })
    .select()
    .single();

  if (error) throw new Error(`Erro ao salvar brain dump: ${error.message}`);
  return data;
}

// ─── 2. TASK BREAKDOWNS (Quebra de Tarefas) ───────────────────────────────────
export async function coreCreateTaskBreakdown(userId: number, payload: any) {
  const { data, error } = await supabase
    .schema('jarvis')
    .from('task_breakdowns')
    .insert({
      user_id: userId,
      original_task: payload.original_task,
      spice_level: payload.spice_level,
      steps: payload.steps,
      used_in_focus: payload.used_in_focus || false,
    })
    .select()
    .single();

  if (error) throw new Error(`Erro ao salvar quebra de tarefa: ${error.message}`);
  return data;
}

// ─── 3. MATRIZ DE EISENHOWER ──────────────────────────────────────────────────
export async function coreCreateEisenhowerItem(userId: number, payload: any) {
  const { data, error } = await supabase
    .schema('jarvis')
    .from('eisenhower_items')
    .insert({
      user_id: userId,
      text: payload.text,
      quadrant: payload.quadrant,
      completed: payload.completed || false,
    })
    .select()
    .single();

  if (error) throw new Error(`Erro ao salvar item na matriz: ${error.message}`);
  return data;
}

// ─── 4. SESSÕES DE FOCO ───────────────────────────────────────────────────────
export async function coreCreateFocusSession(userId: number, payload: any) {
  const { data, error } = await supabase
    .schema('jarvis')
    .from('focus_sessions')
    .insert({
      user_id: userId,
      started_at: payload.started_at || new Date().toISOString(),
      ended_at: payload.ended_at,
      task_original: payload.task_original,
      steps_completed: payload.steps_completed,
      steps_total: payload.steps_total,
      cancelled: payload.cancelled,
      reward_chosen: payload.reward_chosen,
      halt_triggered: payload.halt_triggered,
    })
    .select()
    .single();

  if (error) throw new Error(`Erro ao salvar sessão de foco: ${error.message}`);
  return data;
}

// ─── 5. RESUMO EXECUTIVO (Sumário) ────────────────────────────────────────────
export async function coreGetFocusSummary(userId: number) {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekIso = weekAgo.toISOString();

  const [sessionsRes, breakdownsRes, pendingRes, dumpsRes] = await Promise.all([
    supabase.schema('jarvis').from('focus_sessions').select('*').eq('user_id', userId).gte('started_at', weekIso),
    supabase.schema('jarvis').from('task_breakdowns').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
    supabase.schema('jarvis').from('eisenhower_items').select('*').eq('user_id', userId).eq('completed', false),
    supabase.schema('jarvis').from('brain_dumps').select('*').eq('user_id', userId).gte('created_at', weekIso),
  ]);

  const sessions = sessionsRes.data || [];
  const breakdowns = breakdownsRes.data || [];
  const pending = pendingRes.data || [];
  const dumps = dumpsRes.data || [];

  const totalSessions = sessions.length;
  const completedSessions = sessions.filter(s => !s.cancelled && s.ended_at).length;
  const cancelledSessions = sessions.filter(s => s.cancelled).length;
  
  const quadrantCounts = {
    q1: pending.filter(i => i.quadrant === 'q1').length,
    q2: pending.filter(i => i.quadrant === 'q2').length,
    q3: pending.filter(i => i.quadrant === 'q3').length,
    q4: pending.filter(i => i.quadrant === 'q4').length,
  };

  let summary = `[RESUMO EXECUTIVO DO LEV - FOCO E PRODUTIVIDADE]\n`;
  summary += `- Sessões de foco (últimos 7 dias): ${totalSessions} total, ${completedSessions} concluídas, ${cancelledSessions} canceladas.\n`;
  summary += `- Tarefas quebradas salvas: ${breakdowns.length}.\n`;
  summary += `- Matriz de Eisenhower: ${pending.length} pendentes. Distribuição: 🔥 Q1: ${quadrantCounts.q1}, 📅 Q2: ${quadrantCounts.q2}, 🤝 Q3: ${quadrantCounts.q3}, 🗑 Q4: ${quadrantCounts.q4}.\n`;
  summary += `- Despejos rápidos (últimos 7 dias): ${dumps.length}.\n`;

  if (cancelledSessions >= 3) {
    summary += `\n⚠️ Atenção: houve ${cancelledSessions} cancelamentos de foco. Considere sugerir uma pausa ou revisar a dificuldade das tarefas.\n`;
  }
  if (completedSessions === 0 && totalSessions > 0) {
    summary += `\n💡 O usuário iniciou sessões mas não concluiu nenhuma. Pode estar enfrentando bloqueio.\n`;
  } else if (completedSessions > 3) {
    summary += `\n🎉 Bom progresso! Muitas sessões concluídas. Reforce positivamente.\n`;
  }

  return summary;
}
