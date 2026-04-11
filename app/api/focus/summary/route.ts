import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [sessionsRes, breakdownsRes, pendingRes, dumpsRes] = await Promise.all([
    supabase.from('focus_sessions').select('*').eq('user_id', userId).gte('started_at', weekAgo.toISOString()),
    supabase.from('task_breakdowns').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
    supabase.from('eisenhower_items').select('*').eq('user_id', userId).eq('completed', false),
    supabase.from('brain_dumps').select('*').eq('user_id', userId).gte('created_at', weekAgo.toISOString()),
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

  return NextResponse.json({ summary });
}