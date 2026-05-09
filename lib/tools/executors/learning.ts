// lib/tools/executors/learning.ts
// Domínio: Aprendizado e Logs de Execução
// Tools: (sem tools expostas ao modelo — uso interno apenas)

import { supabase } from '@/lib/jarvis';

interface LogToolExecutionParams {
  userId: number;
  toolName: string;
  arguments: Record<string, any>;
  output: string;
  contextSnapshot?: Record<string, any>; // últimos N turnos do chat
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
        user_id: userId,
        tool_name: toolName,
        arguments: args,
        output,
        context_snapshot: contextSnapshot ?? null,
      });
  } catch (err) {
    // Silencioso — nunca travar a resposta do usuário por causa do log
    console.error('[learning] Falha ao salvar execution_log:', err);
  }
}