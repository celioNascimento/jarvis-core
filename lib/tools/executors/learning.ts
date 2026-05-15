// lib/tools/executors/learning.ts
// Responsável por capturar correções de identidade e contexto em tempo real.

import { supabase } from '@/lib/jarvis';
import { invalidateMasterContextCache } from '../../pipeline/intelligence';

// Padrões linguísticos de que o usuário está corrigindo a IA
const CORRECTION_MARKERS = [
  /não é o/i, /não é a/i, /errou/i, /falei/i, /estamos falando d/i,
  /confundiu/i, /oxe/i, /tá doido/i, /quem é/i, /trocou os nomes/i
];

/**
 * Detecta se a mensagem atual é uma correção ao erro anterior do Jarvis.
 * Se for, salva como um insight de alta confiança.
 */
export async function detectAndLogCorrection(
  message: string,
  userId: number,
  safeContext: any
): Promise<void> {
  const isCorrection = CORRECTION_MARKERS.some(regex => regex.test(message));
  
  if (!isCorrection) return;

  console.info(`[Learning] Possível correção detectada: "${message}"`);

  // 1. Extração simples (Pode ser evoluída com um mini-call de LLM se quiser ser ultra rigoroso)
  // Por enquanto, vamos marcar que houve uma correção de contexto nesta sessão.
  
  try {
    const insightText = `Correção de contexto: ${message}`;

    // 2. Salva na tabela de insights aprendidos
    const { error } = await supabase
      .schema('jarvis')
      .from('learned_insights')
      .insert({
        user_id: userId,
        insight_text: insightText,
        source_type: 'user_corrected',
        confidence_score: 1.0, // Erro corrigido pelo usuário é verdade absoluta
        is_active: true,
        metadata: {
          original_message: message,
          timestamp: new Date().toISOString()
        }
      });

    if (error) throw error;

    // 3. CRÍTICO: Invalida o cache do MasterContext imediatamente.
    // Isso garante que a PRÓXIMA resposta já veja esse novo insight.
    const sessionId = safeContext.history?.[0]?.session_id;
    if (sessionId) {
      await invalidateMasterContextCache(userId, sessionId);
    }

    console.info('[Learning] Insight de correção persistido e cache invalidado.');

  } catch (e) {
    console.error('[Learning] Falha ao processar aprendizado:', e);
  }
}

/**
 * Detecta feedback negativo implícito (ex: usuário repetindo a mesma pergunta)
 */
export async function detectImplicitNegativeFeedback(
  message: string,
  userId: number
): Promise<void> {
  // Lógica para detectar se o usuário está frustrado sem dizer "você errou"
  // Ex: "Verifique as últimas mensagens" após uma resposta errada.
  if (message.toLowerCase().includes('verifique') || message.toLowerCase().includes('olha o que eu disse')) {
    // Logar para análise futura de fine-tuning
    console.warn('[Learning] Feedback implícito de falha de contexto detectado.');
  }
}
