// lib/tools/executors/learning.ts
// V9.2.0 — Blindagem de Selects (maybeSingle)

import { supabase } from '@/lib/jarvis';

const CORRECTION_PATTERNS = [
  /não (é|foi|era) isso/i, /eu prefiro/i, /para de/i, /não quero/i,
  /errado/i, /não (assim|dessa forma|desse jeito)/i, /me corrijo/i,
  /na verdade/i, /muda (isso|aquilo)/i, /não faça (mais )?isso/i,
];

function isCorrectionMessage(message: string): boolean {
  return CORRECTION_PATTERNS.some(p => p.test(message));
}

function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean));
  const setA = tokenize(a);
  const setB = tokenize(b);
  const intersection = new Set([...setA].filter(t => setB.has(t)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

const REPHRASING_THRESHOLD = 0.45;
const MIN_MESSAGE_LENGTH = 15;

interface LogToolExecutionParams {
  userId: number;
  toolName: string;
  arguments: Record<string, any>;
  output: string;
  contextSnapshot?: Record<string, any>[];
}

export async function logToolExecution({ userId, toolName, arguments: args, output, contextSnapshot }: LogToolExecutionParams): Promise<void> {
  try {
    await supabase.schema('jarvis').from('execution_logs').insert({
      user_id: userId,
      tool_name: toolName,
      arguments: args,
      output,
      context_snapshot: contextSnapshot ?? null,
    });
  } catch (err) {
    console.error('[learning] Falha ao salvar execution_log:', err);
  }
}

export async function detectAndLogCorrection(message: string, userId: number, safeContext?: any): Promise<void> {
  if (!isCorrectionMessage(message)) return;

  try {
    // ✅ MUDANÇA AQUI: Uso explícito do maybeSingle() para evitar falhas ou arrays fantasmas
    const { data: log, error } = await supabase
      .schema('jarvis')
      .from('execution_logs')
      .select('id')
      .eq('user_id', userId)
      .eq('user_feedback_received', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !log) return;

    await supabase
      .schema('jarvis')
      .from('execution_logs')
      .update({ user_feedback_received: true, user_feedback_text: message })
      .eq('id', log.id);

  } catch (err) {
    console.error('[learning] Falha ao registrar correção:', err);
  }
}

export async function detectImplicitNegativeFeedback(currentMessage: string, userId: number): Promise<void> {
  if (currentMessage.length < MIN_MESSAGE_LENGTH) return;

  try {
    // ✅ MUDANÇA AQUI: maybeSingle()
    const { data: lastMessageRow, error: brainError } = await supabase
      .from('brain')
      .select('content')
      .eq('user_id', userId)
      .eq('metadata->>role', 'user')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (brainError || !lastMessageRow) return;

    const lastMessage = lastMessageRow.content as string;
    if (!lastMessage || lastMessage.length < MIN_MESSAGE_LENGTH) return;

    const similarity = jaccardSimilarity(currentMessage, lastMessage);
    if (similarity < REPHRASING_THRESHOLD) return;

    const { data: log, error: logError } = await supabase
      .schema('jarvis')
      .from('execution_logs')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (logError || !log) return;

    await supabase
      .schema('jarvis')
      .from('execution_logs')
      .update({
        user_feedback_received: true,
        user_feedback_text: `[REPERGUNTA IMPLÍCITA] "${currentMessage.slice(0, 200)}"`,
      })
      .eq('id', log.id);

  } catch (err) {
    console.error('[learning] Falha ao detectar repergunta:', err);
  }
}
