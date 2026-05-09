// lib/tools/executors/learning.ts
// Domínio: Aprendizado e Logs de Execução
// Uso interno apenas — nunca exposto como tool ao modelo.

import { supabase } from '@/lib/jarvis';

// ─── Padrões de correção ──────────────────────────────────────────────────────

const CORRECTION_PATTERNS = [
  /não (é|foi|era) isso/i,
  /eu prefiro/i,
  /para de/i,
  /não quero/i,
  /errado/i,
  /não (assim|dessa forma|desse jeito)/i,
  /me corrijo/i,
  /na verdade/i,
  /muda (isso|aquilo)/i,
  /não faça (mais )?isso/i,
];

function isCorrectionMessage(message: string): boolean {
  return CORRECTION_PATTERNS.some(p => p.test(message));
}

// ─── Log de execução ──────────────────────────────────────────────────────────

interface LogToolExecutionParams {
  userId: number;
  toolName: string;
  arguments: Record<string, any>;
  output: string;
  contextSnapshot?: Record<string, any>[];
}

export async function logToolExecution({
  userId,
  toolName,
  arguments: args,
  output,
  contextSnapshot,
}: LogToolExecutionParams): Promise<void> {
  try {
    await supabase
      .schema('jarvis')
      .from('execution_logs')
      .insert({
        user_id:          userId,
        tool_name:        toolName,
        arguments:        args,
        output,
        context_snapshot: contextSnapshot ?? null,
      });
  } catch (err) {
    console.error('[learning] Falha ao salvar execution_log:', err);
  }
}

// ─── Detecção de correção ─────────────────────────────────────────────────────

export async function detectAndLogCorrection(
  message: string,
  userId: number
): Promise<void> {
  if (!isCorrectionMessage(message)) return;

  try {
    // Busca o log mais recente desse usuário (ainda sem feedback)
    const { data: logs, error } = await supabase
      .schema('jarvis')
      .from('execution_logs')
      .select('id')
      .eq('user_id', userId)
      .eq('user_feedback_received', false)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !logs?.length) return;

    await supabase
      .schema('jarvis')
      .from('execution_logs')
      .update({
        user_feedback_received: true,
        user_feedback_text:     message,
      })
      .eq('id', logs[0].id);

  } catch (err) {
    console.error('[learning] Falha ao registrar correção:', err);
  }
}