// lib/tools/executors/learning.ts
// V10.0.0 — Integração Total: Logs Técnicos + Memória Biológica + Guardião de Escopo

import { supabase } from '@/lib/jarvis';
import { invalidateMasterContextCache } from '@/lib/chat/pipeline/intelligence';

// --- CONFIGURAÇÕES E PADRÕES ---
const CORRECTION_PATTERNS = [
  /não (é|foi|era) isso/i, /eu prefiro/i, /para de/i, /não quero/i,
  /errado/i, /não (assim|dessa forma|desse jeito)/i, /me corrijo/i,
  /na verdade/i, /muda (isso|aquilo)/i, /não faça (mais )?isso/i,
  /oxe/i, /estamos falando de/i, /confundiu/i, /tá doido/i, /o nome dele é/i
];

const SCOPE_CHANGE_MARKERS = [
  /tive uma ideia/i, /podemos adicionar/i, /seria legal se/i, 
  /muda o seguinte/i, /novo módulo/i, /outra coisa/i
];

const REPHRASING_THRESHOLD = 0.45;
const MIN_MESSAGE_LENGTH = 15;

// --- AUXILIARES ---
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

interface LogToolExecutionParams {
  userId: number;
  toolName: string;
  arguments: Record<string, any>;
  output: string;
  contextSnapshot?: Record<string, any>[];
}

// --- EXPORTAÇÕES ---

/**
 * Mantém o seu log técnico de execução de ferramentas.
 */
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

/**
 * Função principal de correção - Unindo Log Técnico + Memória de Longo Prazo
 */
export async function detectAndLogCorrection(message: string, userId: number, safeContext?: any): Promise<void> {
  if (!isCorrectionMessage(message)) return;

  try {
    // 1. ATUALIZA LOG DE EXECUÇÃO (Seu código original)
    const { data: log, error } = await supabase
      .schema('jarvis')
      .from('execution_logs')
      .select('id')
      .eq('user_id', userId)
      .eq('user_feedback_received', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (log && !error) {
      await supabase
        .schema('jarvis')
        .from('execution_logs')
        .update({ user_feedback_received: true, user_feedback_text: message })
        .eq('id', log.id);
    }

    // 2. TATUAGEM NA MEMÓRIA (O que faltava para o caso Davi/Miguel)
    // Salva o insight para que o Assembler leia na próxima rodada
    await supabase.schema('jarvis').from('learned_insights').insert({
      user_id: userId,
      insight_text: `CORREÇÃO DE CONTEXTO: ${message}`,
      source_type: 'user_corrected',
      confidence_score: 1.0,
      is_active: true
    });

    // 3. LIMPEZA DE CACHE IMEDIATA
    // Se o usuário corrigiu, o Redis atual não serve mais.
    const sessionId = safeContext?.history?.[0]?.session_id;
    if (sessionId) {
      await invalidateMasterContextCache(userId, sessionId);
    }

    // 4. ESTACIONAMENTO DE IDEIAS (Rigor de Escopo)
    const isNewIdea = SCOPE_CHANGE_MARKERS.some(regex => regex.test(message));
    const activeContexts = safeContext?.history?.[0]?.metadata?.contexts || [];
    const isProjectSession = activeContexts.some((c: string) => c.includes('PQF') || c.includes('ExpertFrotas'));

    if (isNewIdea && isProjectSession) {
      await supabase.schema('jarvis').from('learned_insights').insert({
        user_id: userId,
        insight_text: `IDEIA ESTACIONADA: ${message}`,
        source_type: 'inferred',
        confidence_score: 0.9,
        is_active: true,
        metadata: { status: 'parking_lot', project_context: activeContexts }
      });
    }

  } catch (err) {
    console.error('[learning] Falha no processo de aprendizado:', err);
  }
}

/**
 * Detecta repergunta implícita (Mantendo seu Jaccard Similarity original)
 */
export async function detectImplicitNegativeFeedback(currentMessage: string, userId: number): Promise<void> {
  if (currentMessage.length < MIN_MESSAGE_LENGTH) return;

  try {
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
