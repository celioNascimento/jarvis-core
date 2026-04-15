// lib/chat/pattern-promoter.ts
// Promoção automática de padrões comportamentais para jarvis.principles
// Fluxo: RPC Postgres (zero tokens) → Gemini Flash (redigir, ~50 tokens) → insert

import { supabase } from '@/lib/jarvis';
import { callOpenRouterWithTools } from '@/lib/chat/openrouter';

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface PromotablePattern {
  pattern_key: string;
  flag: string;
  dominant_context: string | null;
  occurrences: number;
  avg_overall: number;
  avg_conciseness: number;
  avg_emotional_fit: number;
  suggested_category: string;
  sample_note: string | null;
}

interface PendingNotification {
  id: number;
  content: string;
  category: string;
}

interface PromoteResult {
  promoted: number;           // quantos padrões foram promovidos
  notification: string | null; // mensagem para o usuário (1ª promoção apenas)
}

// ─── Função principal ─────────────────────────────────────────────────────────

export async function promotePatternToPrinciple(
  userId: number,
  authorName: string,
  assistantName: string,
): Promise<PromoteResult> {
  const result: PromoteResult = { promoted: 0, notification: null };

  try {
    // ── 1. Detectar padrões via RPC (zero tokens) ─────────────────────────────
    const { data: patterns, error: rpcError } = await supabase
      .rpc('detect_promotable_patterns', {
        p_user_id:         userId,
        p_min_occurrences: 3,
        p_min_confidence:  0.70,
        p_lookback_days:   30,
      }) as { data: PromotablePattern[] | null; error: any };

    if (rpcError) {
      console.error('[PatternPromoter] RPC error:', rpcError.message);
      return result;
    }

    if (!patterns || patterns.length === 0) {
      console.log('[PatternPromoter] Nenhum padrão elegível para promoção.');
      return result;
    }

    console.log(`[PatternPromoter] ${patterns.length} padrão(ões) elegível(eis):`, patterns.map(p => p.pattern_key));

    // ── 2. Para cada padrão, redigir princípio com Gemini Flash (~50 tokens) ──
    for (const pattern of patterns) {
      try {
        const principle = await draftPrinciple(pattern, authorName, assistantName);
        if (!principle) continue;

        // ── 3. Inserir em jarvis.principles ──────────────────────────────────
        const { error: insertError } = await supabase
          .schema('jarvis')
          .from('principles')
          .insert({
            user_id:     userId,
            content:     principle,
            category:    pattern.suggested_category,
            source:      'promoted',
            confidence:  parseFloat((1 - pattern.avg_overall).toFixed(3)), // quanto mais baixo o score, maior a confiança no problema
            pattern_key: pattern.pattern_key,
            promoted_at: new Date().toISOString(),
            notified:    false,
          });

        if (insertError) {
          // Ignorar erro de duplicata (unique constraint) silenciosamente
          if (insertError.code === '23505') {
            console.log('[PatternPromoter] Padrão já promovido (duplicata):', pattern.pattern_key);
            continue;
          }
          console.error('[PatternPromoter] Insert error:', insertError.message);
          continue;
        }

        result.promoted++;
        console.log(`[PatternPromoter] ✅ Promovido: ${pattern.pattern_key} → "${principle.slice(0, 60)}..."`);

      } catch (e) {
        console.error('[PatternPromoter] Erro ao processar padrão:', pattern.pattern_key, (e as Error).message);
      }
    }

    // ── 4. Verificar notificações pendentes (source=promoted, notified=false) ─
    if (result.promoted > 0) {
      result.notification = await buildNotificationMessage(userId, assistantName);
    }

  } catch (e) {
    console.error('[PatternPromoter] Erro geral:', (e as Error).message);
  }

  return result;
}

// ─── Redigir princípio com Gemini Flash ───────────────────────────────────────

async function draftPrinciple(
  pattern: PromotablePattern,
  authorName: string,
  assistantName: string,
): Promise<string | null> {
  const contextLabel = pattern.dominant_context || 'geral';

  const flagDescriptions: Record<string, string> = {
    verbose:        'as respostas tendem a ser longas demais e perdem foco',
    cold:           'o tom está frio ou distante, faltando presença humana',
    missed_emotion: 'momentos emocionais estão sendo tratados de forma técnica ou ignorados',
    off_topic:      'a resposta desvia do que foi perguntado',
  };

  const flagDesc = flagDescriptions[pattern.flag] || `há um padrão de "${pattern.flag}"`;

  const prompt = `Você é o sistema interno do assistente pessoal ${assistantName}.
Detectamos um padrão comportamental que precisa ser corrigido:

- Contexto recorrente: "${contextLabel}"
- Problema identificado: ${flagDesc}
- Ocorrências: ${pattern.occurrences} vezes nos últimos 30 dias
- Score médio de qualidade: ${(pattern.avg_overall * 100).toFixed(0)}%
- Nota do avaliador: "${pattern.sample_note || 'sem nota'}"

Redija UM princípio comportamental em português, primeira pessoa (como instrução para si mesmo).
Deve ser:
- Direto e específico para o contexto "${contextLabel}"
- Máximo 25 palavras
- Sem julgamento, apenas orientação prática
- Começa com verbo no imperativo

Responda APENAS com o texto do princípio, sem aspas, sem markdown, sem explicação.`;

  try {
    const response = await callOpenRouterWithTools(
      [{ role: 'user', content: prompt }],
      [],
      'google/gemini-flash-1.5',
      0.3,
      3000,
      80,
      'none',
    );

    const principle = response.content?.trim().replace(/^["']|["']$/g, '');
    if (!principle || principle.length < 5) return null;
    return principle;

  } catch (e) {
    console.error('[PatternPromoter] draftPrinciple falhou:', (e as Error).message);
    return null;
  }
}

// ─── Montar mensagem de notificação natural ───────────────────────────────────

async function buildNotificationMessage(
  userId: number,
  assistantName: string,
): Promise<string | null> {
  try {
    const { data: pending, error } = await supabase
      .rpc('get_pending_notifications', { p_user_id: userId }) as {
        data: PendingNotification[] | null;
        error: any;
      };

    if (error || !pending || pending.length === 0) return null;

    // Notifica apenas a primeira promoção de forma natural
    const first = pending[0];

    // Marca como notificado
    await supabase
      .schema('jarvis')
      .from('principles')
      .update({ notified: true })
      .in('id', pending.map(p => p.id));

    // Mensagens naturais por categoria
    const messages: Record<string, string> = {
      brevidade:      `Percebi que costumo me alongar quando o assunto é técnico — vou ser mais direto.`,
      tom:            `Notei que meu tom às vezes fica distante. Vou me aproximar mais.`,
      emocao:         `Percebi que em momentos mais pesados nem sempre respondo com a presença certa — vou melhorar isso.`,
      foco:           `Tendência de desviar do assunto em alguns contextos — vou focar mais no que foi perguntado.`,
      comportamento:  `Ajustei algo no meu comportamento com base no que observei nas nossas conversas.`,
    };

    return messages[first.category] || messages['comportamento'];

  } catch (e) {
    console.error('[PatternPromoter] buildNotificationMessage falhou:', (e as Error).message);
    return null;
  }
}
