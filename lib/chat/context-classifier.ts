// lib/chat/context-classifier.ts
// V9.0.0 — Merge completo: regex normalizada + L4 com LLM + novos contextos
//           (tdah, foco, trabalho, financas, diario, rotina, alias, preferencia, recomendacao)

import { supabase } from '@/lib/jarvis';
import { callOpenRouter } from '@/lib/jarvis';

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type ContextType =
  | 'casual'
  | 'agenda'
  | 'email'
  | 'saude'
  | 'familia'
  | 'trabalho'
  | 'projeto'
  | 'meta'
  | 'emocao'
  | 'diario'
  | 'rotina'
  | 'preferencia'
  | 'alias'
  | 'recomendacao'
  | 'esporte'
  | 'noticias'
  | 'clima'
  | 'math'
  | 'trivial'
  | 'compras'
  | 'financas'
  | 'evento'
  | 'tdah'
  | 'foco';

const ALL_CONTEXTS: ContextType[] = [
  'casual', 'agenda', 'email', 'saude', 'familia', 'trabalho', 'projeto',
  'meta', 'emocao', 'diario', 'rotina', 'preferencia', 'alias', 'recomendacao',
  'esporte', 'noticias', 'clima', 'math', 'trivial', 'compras', 'financas',
  'evento', 'tdah', 'foco',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Remove acentos para comparação normalizada */
function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ─── Regras regex (normalizadas, case-insensitive) ────────────────────────────

const RULES_NORMALIZED: Array<[RegExp, ContextType]> = ([
  [norm('diario|diário|hoje foi|hoje ta|hoje está|acordei|dormi|dormir|meu dia|como foi meu|reflexao|refletindo|gratid'), 'diario'],
  [norm('meta|objetivo|quero (conseguir|fazer|terminar|lancar|comecar)|prazo|progresso|etapa|concluir|finalizar'), 'meta'],
  [norm('reuniao|reunião|consulta|compromisso|agend|horario|horário|amanha as|amanhã às|segunda|terça|quarta|quinta|sexta|sabado|domingo|às \\d|as \\d{1,2}h'), 'agenda'],
  [norm('projeto|app|aplicativo|sistema|api|deploy|feature|sprint|mvp|startup|produto|desenvolv'), 'projeto'],
  [norm('filho|filha|esposa|marido|mae|mãe|pai|irmao|irmão|família|familia|cônjuge|conjuge|casamento|nasceu|aniversario de casamento'), 'familia'],
  [norm('medic|médic|saude|saúde|exame|remedio|remédio|hospital|dor|doenca|doença|sintoma|consulta médica'), 'saude'],
  [norm('sinto|estou (triste|feliz|ansioso|cansado|animado|frustrado|preocupado|deprimido|sozinho)|me sinto|to mal|tô mal|to bem|tô bem|angustia|angústia|estressado|triste|ansios|deprimid|chorei|choro|difícil|foi pesado'), 'emocao'],
  [norm('email|e-mail|inbox|caixa de entrada|mensagem do|mensagem da|enviou|recebeu|outlook|gmail'), 'email'],
  [norm('indica|recomend|sugere|onde posso|tem algum|onde tem|restaurante|lugar bom|conhece algum'), 'recomendacao'],
  [norm('aniversario|aniversário|natal|pascoa|páscoa|ano novo|feriado|data importante|comemora|show|festa|formatura|viagem'), 'evento'],
  [norm('acordo|desperto|academia|treino|trabalho as|trabalho às|entrada no trabalho|saida do trabalho|rotina|horario de'), 'rotina'],
  [norm('gosto de|nao gosto de|não gosto de|prefiro|adoro|odeio|minha comida|meu filme|minha musica|minha música'), 'preferencia'],
  [norm('quando falo em|quando eu falar|pode chamar de|se eu disser|apelido|alias'), 'alias'],
  [norm('jogo|partida|futebol|basquete|vôlei|volei|tenis|f1|corrida|campeonato|copa|campeonato brasileiro|libertadores|copa do brasil|série a|série b|classificação|tabela|artilheiro|resultado|placar|hoje tem jogo|quando é o jogo|proximo jogo|próximo jogo|data do jogo|horário do jogo|escalação'), 'esporte'],
  [norm('noticia|notícias|últimas|recente|aconteceu|hoje no|manchete|jornal|portal|g1|globo|folha|estadão|política|politica|eleição|eleicao|governo'), 'noticias'],
  [norm('clima|tempo|temperatura|chuva|frio|calor|previsão|previsao|amanhecer|entardecer|umidade|vento|chover|chuvoso|vai chover|como esta o tempo|como esta o clima|céu|ceu'), 'clima'],
  [norm('compra|compras|mercado|supermercado|feira|lista de compras|item|itens|precisamos de|falta em casa|acabou o|acabou a|precisando de|faltando'), 'compras'],
  [norm('gastei|paguei|recebi|salário|salario|despesa|receita|conta|comprei|boleto|fatura|orçamento|orcamento|finanças|financas|dinheiro|grana|divida|dívida|cartao|cartão|credito|crédito|debito|débito|investimento|poupanca|poupança|saldo|extrato|gasto|pix|ted|transacao|transação|banco|nubank|itaú|itau|bradesco|santander|inter|caixa econômica'), 'financas'],
  [norm('trabalho|empresa|chefe|colega|reunião de trabalho|tarefa|prazo|entrega|cliente'), 'trabalho'],
  [norm('foco|tdah|procrastinando|travado|paralisado|sobrecarregado|por onde começo|nao sei comecar'), 'tdah'],
] as Array<[string, ContextType]>).map(([src, ctx]) => [new RegExp(src, 'i'), ctx]);

/** Regras verbatim (sem normalização de acentos) */
const RULES_VERBATIM: Array<[RegExp, ContextType]> = [
  [/^\d+[\+\-\*\/]\d+|^[0-9+\-*/%() ]+$/,                                              'math'],
  [/quanto [eé]|quanto d[aá]|calcule|soma|subtraia|multiplique|divida|raiz|pot[eê]ncia|quanto é|calcul|porcentagem|^[0-9]+ (mais|vezes|dividido por|menos) [0-9]+/i, 'math'],
  [/^(ok|oi|ol[aá]|bom dia|boa tarde|boa noite|tudo bem|tudo bom|blz|vlw|valeu|obrigad|kkk|haha|rs|👍|🙏|😂|!)[\s!?.]*$/i, 'trivial'],
  [/R\$|\breal\b/i, 'financas'],
];

// ─── classifyContextRegex ─────────────────────────────────────────────────────

export function classifyContextRegex(text: string): ContextType[] {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const detected: ContextType[] = [];

  for (const [rx, ctx] of RULES_NORMALIZED) {
    if (rx.test(normalized)) detected.push(ctx);
  }

  for (const [rx, ctx] of RULES_VERBATIM) {
    if (rx.test(text)) detected.push(ctx);
  }

  return detected.length > 0 ? ([...new Set(detected)] as ContextType[]) : ['casual'];
}

// ─── classifyContextWithL4 ────────────────────────────────────────────────────

export async function classifyContextWithL4(
  text: string,
  userId: string
): Promise<ContextType[]> {
  const regexContexts = classifyContextRegex(text);

  // Atalho para casos simples
  if (regexContexts.includes('math') || regexContexts.includes('trivial')) {
    return regexContexts;
  }
  if (text.length < 40 && regexContexts.length <= 2) {
    return regexContexts;
  }

  // Priorização via topic_index quando há muitos contextos
  if (regexContexts.length > 2) {
    const { data: topicWeights } = await supabase
      .from('topic_index')
      .select('topic, weight')
      .eq('user_id', userId)
      .in('topic', regexContexts);

    if (topicWeights?.length) {
      const sorted = [...topicWeights].sort((a, b) => (b.weight || 0) - (a.weight || 0));
      const prioritized = sorted.map((t) => t.topic as ContextType);
      const missing = regexContexts.filter((c) => !prioritized.includes(c));
      return [...prioritized, ...missing];
    }
  }

  // Enriquecimento com LLM
  try {
    const prompt = `Classifique a mensagem abaixo em 1-3 categorias da lista:
${ALL_CONTEXTS.join(', ')}

Mensagem: "${text.slice(0, 200)}"

Responda APENAS com JSON: {"contexts": ["cat1", "cat2"]}`;

    const raw = await callOpenRouter(prompt, 'flash', 0.1);
    const cleaned = raw.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const llmContexts = (parsed.contexts as ContextType[]).filter((c) =>
      ALL_CONTEXTS.includes(c)
    );

    // Merge: regex + LLM, sem duplicatas
    return [...new Set([...regexContexts, ...llmContexts])] as ContextType[];
  } catch {
    return regexContexts;
  }
}

// ─── routeModel ───────────────────────────────────────────────────────────────

export function routeModel(
  contexts: ContextType[],
  emotionalScore: number,
  topicEmotionalDimension?: number
): { model: string; label: string } {
  const effectiveEmotional = Math.max(emotionalScore, topicEmotionalDimension ?? 0);

  if (effectiveEmotional > 0.7)
    return { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet-emocional' };

  if (contexts.some((c) => ['emocao', 'familia', 'saude', 'diario'].includes(c)))
    return { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet-pessoal' };

  if (contexts.some((c) => ['trabalho', 'projeto', 'meta', 'financas'].includes(c)))
    return { model: 'google/gemini-2.5-pro', label: 'pro-trabalho' };

  const flashFriendly: ContextType[] = [
    'esporte', 'noticias', 'clima', 'casual', 'rotina',
    'alias', 'preferencia', 'recomendacao', 'math', 'trivial', 'compras',
  ];
  if (contexts.includes('agenda') && effectiveEmotional < 0.4)
    return { model: 'google/gemini-2.0-flash-001', label: 'flash-agenda' };
  if (contexts.some((c) => flashFriendly.includes(c)))
    return { model: 'google/gemini-2.0-flash-001', label: 'flash-default' };

  return { model: 'google/gemini-2.0-flash-001', label: 'flash-default' };
}

// ─── getTemperature ───────────────────────────────────────────────────────────

export function getTemperature(contexts: ContextType[]): number {
  if (contexts.includes('math') || contexts.includes('trivial')) return 0.2;
  if (contexts.some((c) => ['emocao', 'diario'].includes(c)))              return 0.9;
  if (contexts.some((c) => ['emocao', 'familia'].includes(c)))             return 0.85;
  if (contexts.some((c) => ['casual', 'projeto', 'meta', 'esporte', 'trivial'].includes(c))) return 0.7;
  if (contexts.some((c) => ['trabalho', 'projeto'].includes(c)))           return 0.5;
  if (contexts.includes('financas'))                                        return 0.3;
  if (contexts.some((c) => ['rotina', 'alias', 'preferencia', 'recomendacao', 'noticias', 'clima', 'compras'].includes(c))) return 0.5;
  if (contexts.some((c) => ['agenda', 'evento', 'email', 'saude'].includes(c))) return 0.3;
  return 0.7;
}

// ─── planContextualBlocks ─────────────────────────────────────────────────────

export function planContextualBlocks(contexts: ContextType[]): {
  loadCalendar:        boolean;
  loadEmail:           boolean;
  loadL3:              boolean;
  loadHD:              boolean;
  loadAshes:           boolean;
  loadTopics:          boolean;
  loadDiary:           boolean;
  loadRecommendations: boolean;
  loadGaps:            boolean;
  loadFinances:        boolean;
  loadProjects:        boolean;
  loadShopping:        boolean;
  loadPlaces:          boolean;
} {
  const has = (...ctxs: ContextType[]) => ctxs.some((c) => contexts.includes(c));
  const isTrivial    = has('math', 'trivial');
  const isCasualOnly = contexts.length === 1 && contexts[0] === 'casual';

  const hasEmotional  = has('emocao');
  const hasPlanning   = has('agenda', 'evento', 'meta', 'projeto');
  const hasFinancial  = has('financas');
  const hasShopping   = has('compras');
  const hasProject    = has('projeto');
  const needsMemory   = hasEmotional || has('diario', 'familia', 'saude') || hasFinancial;
  const needsLongTerm = has('diario', 'emocao');

  return {
    // Blocos de conteúdo externo
    loadCalendar:        has('agenda', 'evento', 'familia') && !isTrivial,
    loadEmail:           has('email') && !isTrivial,

    // Blocos do dossiê e memória
    loadL3:              !isTrivial,
    loadHD:              needsMemory && !isTrivial && !isCasualOnly,
    loadAshes:           (needsLongTerm || has('meta', 'familia')) && !isTrivial,

    // Blocos gerados
    loadTopics:          has('saude', 'projeto', 'familia', 'casual', 'rotina', 'preferencia', 'esporte', 'noticias', 'clima', 'compras') && !isTrivial,
    loadDiary:           has('diario', 'meta', 'emocao', 'casual', 'tdah') && !isTrivial,
    loadRecommendations: has('recomendacao', 'casual', 'emocao') && !isTrivial,
    loadGaps:            (hasPlanning || hasEmotional || hasFinancial || has('trabalho')) && !isTrivial,

    // Condicionais para buildProfileBlock
    loadFinances:        hasFinancial && !isTrivial,
    loadProjects:        hasProject && !isTrivial,
    loadShopping:        hasShopping && !isTrivial,
    loadPlaces:          (hasShopping || has('rotina', 'recomendacao')) && !isTrivial,
  };
}

// ─── detectTopicShiftWithL4 ───────────────────────────────────────────────────

export async function detectTopicShiftWithL4(
  userId: string,
  newContexts: ContextType[]
): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('topic_index')
      .select('topic, last_used_at')
      .eq('user_id', userId)
      .order('last_used_at', { ascending: false })
      .limit(3);

    if (!data || data.length === 0) return false;

    const recentTopics = data.map((t) => t.topic as ContextType);
    const overlap = newContexts.filter((c) => recentTopics.includes(c));
    return overlap.length === 0;
  } catch {
    return false;
  }
}