// lib/chat/pipeline/style-learner.ts
// Captura padrões de vocabulário e comportamento do usuário e promove para principles

import { supabase } from '@/lib/jarvis';

// ─── Mapa de padrões → tags ───────────────────────────────────────────────────
// tag segue o formato 'dimensão:valor' para facilitar agrupamento no prompt
const STYLE_PATTERNS: Array<{ pattern: RegExp; tag: string; description: string }> = [
  // Vocabulário informal masculino
  { pattern: /\b(cara|mano|véi|véio|brother|parceiro|bróder)\b/i,  tag: 'vocab:giria_masc',   description: 'usa gírias masculinas informais ("cara", "mano")' },
  // Vocabulário informal feminino
  { pattern: /\b(miga|bff|gente|menina)\b/i,                        tag: 'vocab:giria_fem',    description: 'usa gírias femininas informais ("miga")' },
  // Humor / risada
  { pattern: /\b(kkk+|haha+|rsrs+|huahua|kkkk)\b/i,                tag: 'humor:risada',       description: 'usa abreviações de risada (kkk, haha, rsrs)' },
  // Energia alta — exclamações e emojis de impacto
  { pattern: /!{2,}|🔥|💀|😂|🤣/,                                  tag: 'energia:alta',       description: 'usa múltiplas exclamações ou emojis de alta energia' },
  // Linguagem técnica / dev
  { pattern: /\b(bug|fix|deploy|commit|merge|pr|branch|debug)\b/i,  tag: 'vocab:tech',         description: 'usa vocabulário técnico de desenvolvimento naturalmente' },
  // Respostas muito curtas / objetivas
  { pattern: /^(ok|sim|não|blz|bora|vai|show|isso|exato|certo)\.?$/i, tag: 'estilo:objetivo', description: 'prefere respostas curtas e objetivas' },
  // Xingamentos leves (para calibrar permissividade)
  { pattern: /\b(porra|caralho|merda|foda|kkk)\b/i,                 tag: 'vocab:palavrao',     description: 'usa palavrões naturalmente na conversa' },
  // Perguntas filosóficas / reflexivas
  { pattern: /\b(por que|será que|faz sentido|você acha)\b/i,        tag: 'estilo:reflexivo',   description: 'tende a fazer perguntas reflexivas e filosóficas' },
];

// ─── Mapa tag → conteúdo que vai para principles ─────────────────────────────
const TAG_TO_PRINCIPLE: Record<string, string> = {
  'vocab:giria_masc':  'Usuário usa gírias masculinas informais ("cara", "mano", "véi"). Incorpore naturalmente quando o tom for casual.',
  'vocab:giria_fem':   'Usuário usa gírias femininas informais ("miga"). Reflita esse vocabulário em contextos descontraídos.',
  'humor:risada':      'Usuário usa abreviações de risada (kkk, haha). O tom pode ser levemente bem-humorado sem forçar.',
  'energia:alta':      'Usuário demonstra energia alta com exclamações e emojis. Combine a energia sem exagerar.',
  'vocab:tech':        'Usuário fala naturalmente com vocabulário de dev. Não explique termos técnicos básicos.',
  'estilo:objetivo':   'Usuário prefere respostas curtas. Vá direto ao ponto, sem introduções.',
  'vocab:palavrao':    'Usuário usa palavrões naturalmente. Pode usar linguagem mais solta, sem forçar.',
  'estilo:reflexivo':  'Usuário tende a ser reflexivo e filosófico. Pode se aprofundar quando o contexto pedir.',
};

// ─── Extrai sinais da mensagem ────────────────────────────────────────────────
export function extractStyleSignals(message: string): string[] {
  return STYLE_PATTERNS
    .filter(({ pattern }) => pattern.test(message))
    .map(({ tag }) => tag);
}

// ─── Persiste sinais e tenta promoção ────────────────────────────────────────
export async function processStyleSignals(
  userId: string,
  message: string,
  threshold = 3
): Promise<void> {
  const tags = extractStyleSignals(message);
  if (tags.length === 0) return;

  const userIdInt = parseInt(userId, 10);

  // Upsert de cada sinal detectado
  for (const tag of tags) {
    await supabase.schema('jarvis').rpc('upsert_style_signal', {
      p_user_id: userIdInt,
      p_tag:     tag,
    });
  }

  // Verifica quais atingiram o threshold e ainda não foram promovidos
  const { data: promotable } = await supabase
    .schema('jarvis')
    .rpc('get_promotable_style_signals', {
      p_user_id:  userIdInt,
      p_threshold: threshold,
    });

  if (!promotable || promotable.length === 0) return;

  // Promove cada sinal para principles
  const promotedTags: string[] = [];

  for (const signal of promotable as { tag: string; count: number }[]) {
    const content = TAG_TO_PRINCIPLE[signal.tag];
    if (!content) continue;

    // Upsert em principles — se já existe o pattern_key, atualiza confidence
    const { error } = await supabase.schema('jarvis').from('principles').upsert(
      {
        user_id:     userIdInt,
        category:    'style',
        content,
        source:      'auto:style-learner',
        confidence:  Math.min(0.5 + signal.count * 0.1, 1.0), // cresce com frequência
        pattern_key: signal.tag,
        promoted_at: new Date().toISOString(),
        notified:    false,
      },
      { onConflict: 'user_id,pattern_key' }
    );

    if (!error) promotedTags.push(signal.tag);
  }

  // Marca como promovidos no style_signals
  if (promotedTags.length > 0) {
    await supabase.schema('jarvis').rpc('mark_style_signals_promoted', {
      p_user_id: userIdInt,
      p_tags:    promotedTags,
    });
  }
}
