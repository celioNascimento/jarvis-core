// lib/tools/executors/learning.ts
// Domínio: Aprendizado e Logs de Execução
// Uso interno apenas — nunca exposto como tool ao modelo.

import { supabase } from '@/lib/jarvis';

// ─── Padrões de correção explícita ───────────────────────────────────────────

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

// ─── Similaridade Jaccard (reutilizada aqui e no debriefing) ─────────────────

function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean));

  const setA = tokenize(a);
  const setB = tokenize(b);

  const intersection = new Set([...setA].filter(t => setB.has(t)));
  const union        = new Set([...setA, ...setB]);

  return union.size === 0 ? 0 : intersection.size / union.size;
}

// Threshold para considerar duas mensagens "a mesma pergunta com outras palavras"
const REPHRASING_THRESHOLD = 0.45;

// Mensagens muito curtas ou genéricas não devem disparar o detector
const MIN_MESSAGE_LENGTH = 15;

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

// ─── Detecção de correção explícita ──────────────────────────────────────────

export async function detectAndLogCorrection(
  message: string,
  userId: number
): Promise<void> {
  if (!isCorrectionMessage(message)) return;

  try {
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

// ─── Detecção de repergunta (feedback implícito) ──────────────────────────────
//
// Se a mensagem atual é semanticamente similar à mensagem anterior do usuário,
// significa que a resposta anterior não foi satisfatória.
// Marca o execution_log mais recente com implicit_negative_feedback = true.
//
// Chamado em persistInBackground (response-finalizer.ts) ANTES de salvar
// a mensagem atual no brain — assim a comparação é sempre com a mensagem
// imediatamente anterior.

export async function detectImplicitNegativeFeedback(
  currentMessage: string,
  userId: number
): Promise<void> {
  if (currentMessage.length < MIN_MESSAGE_LENGTH) return;

  try {
    // 1. Busca a última mensagem do usuário no brain
    const { data: lastMessages, error: brainError } = await supabase
      .from('brain')
      .select('content')
      .eq('user_id', userId)
      .eq('metadata->>role', 'user')
      .order('created_at', { ascending: false })
      .limit(1);

    if (brainError || !lastMessages?.length) return;

    const lastMessage = lastMessages[0].content as string;
    if (!lastMessage || lastMessage.length < MIN_MESSAGE_LENGTH) return;

    // 2. Calcula similaridade entre a mensagem atual e a anterior
    const similarity = jaccardSimilarity(currentMessage, lastMessage);
    if (similarity < REPHRASING_THRESHOLD) return;

    console.log(`[learning] Repergunta detectada (similaridade: ${similarity.toFixed(2)}): "${currentMessage.slice(0, 60)}"`);

    // 3. Busca o execution_log mais recente desse usuário
    const { data: logs, error: logError } = await supabase
      .schema('jarvis')
      .from('execution_logs')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (logError || !logs?.length) return;

    // 4. Marca como feedback negativo implícito
    await supabase
      .schema('jarvis')
      .from('execution_logs')
      .update({
        user_feedback_received: true,
        user_feedback_text:     `[REPERGUNTA IMPLÍCITA] "${currentMessage.slice(0, 200)}"`,
      })
      .eq('id', logs[0].id);

  } catch (err) {
    console.error('[learning] Falha ao detectar repergunta:', err);
  }
}