// lib/chat/context-classifier.ts
import { supabase } from '@/lib/jarvis';

export type ContextType =
  | 'agenda' | 'projeto' | 'familia' | 'emocao' | 'diario'
  | 'meta' | 'saude' | 'recomendacao' | 'evento' | 'rotina'
  | 'preferencia' | 'alias' | 'email' | 'casual' | 'esporte'
  | 'noticias' | 'clima' | 'financas' | 'compras'
  | 'math' | 'trivial';

// Normaliza uma string removendo acentos
function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const RAW_RULES: Array<[string, ContextType]> = [
  [norm('diario|diário|hoje foi|hoje ta|hoje está|acordei|dormi|dormir|meu dia|como foi meu|reflexao|refletindo|gratid'), 'diario'],
  [norm('meta|objetivo|quero (conseguir|fazer|terminar|lancar|comecar)|prazo|progresso|etapa|concluir|finalizar'), 'meta'],
  [norm('reuniao|reunião|consulta|compromisso|agend|horario|horário|amanha as|amanhã às|segunda|terça|quarta|quinta|sexta|sabado|domingo|às \\d|as \\d{1,2}h'), 'agenda'],
  [norm('projeto|app|aplicativo|sistema|api|deploy|feature|sprint|mvp|startup|produto|desenvolv'), 'projeto'],
  [norm('filho|filha|esposa|marido|mae|mãe|pai|irmao|irmão|família|familia|cônjuge|conjuge|casamento|nasceu|aniversario de casamento'), 'familia'],
  [norm('medic|médic|saude|saúde|exame|remedio|remédio|hospital|dor|doenca|doença|sintoma|consulta médica'), 'saude'],
  [norm('sinto|estou (triste|feliz|ansioso|cansado|animado|frustrado|preocupado|deprimido|sozinho)|me sinto|to mal|tô mal|to bem|tô bem|angustia|angústia|estressado'), 'emocao'],
  [norm('email|e-mail|inbox|caixa de entrada|mensagem do|mensagem da|enviou|recebeu'), 'email'],
  [norm('indica|recomend|sugere|onde posso|tem algum|onde tem|restaurante|lugar|lugar bom|conhece algum'), 'recomendacao'],
  [norm('aniversario|aniversário|natal|pascoa|páscoa|ano novo|feriado|data importante|comemora'), 'evento'],
  [norm('acordo|desperto|academia|treino|trabalho as|trabalho às|entrada no trabalho|saida do trabalho|rotina|horario de'), 'rotina'],
  [norm('gosto de|nao gosto de|não gosto de|prefiro|adoro|odeio|minha comida|meu filme|minha musica|minha música'), 'preferencia'],
  [norm('quando falo em|quando eu falar|pode chamar de|se eu disser|apelido|alias'), 'alias'],
  [norm('jogo|partida|futebol|basquete|vôlei|volei|tenis|f1|corrida|campeonato|copa|campeonato brasileiro|libertadores|copa do brasil|série a|série b|classificação|tabela|artilheiro|resultado|placar|hoje tem jogo|quando é o jogo|proximo jogo|próximo jogo|data do jogo|horário do jogo|escalação'), 'esporte'],
  [norm('noticia|notícias|últimas|recente|aconteceu|hoje no|manchete|jornal|portal|g1|globo|folha|estadão'), 'noticias'],
  [norm('clima|tempo|temperatura|chuva|frio|calor|previsão|amanhecer|entardecer|umidade|vento|chover|chuvoso|vai chover|como esta o tempo|como esta o clima'), 'clima'],
  [norm('compra|compras|mercado|supermercado|feira|lista de compras|item|itens|precisamos de|falta em casa|acabou o|acabou a'), 'compras'],
  [norm('dinheiro|grana|salario|salário|conta|contas|pagar|pagamento|divida|dívida|boleto|cartao|cartão|credito|crédito|debito|débito|investimento|poupanca|poupança|saldo|extrato|despesa|gasto|orcamento|orçamento|financ'), 'financas'],
];

const RAW_RULES_VERBATIM: Array<[RegExp, ContextType]> = [
  [/^[0-9+\-*/%() ]+$/, 'math'],
  [/quanto [eé]|quanto d[aá]|calcule|soma|subtraia|multiplique|divida|raiz|pot[eê]ncia|^[0-9]+ (mais|vezes|dividido por|menos) [0-9]+/i, 'math'],
  [/^(ok|oi|ol[aá]|bom dia|boa tarde|boa noite|tudo bem|tudo bom|blz|vlw|valeu|obrigad|kkk|haha|rs|👍|🙏|😂|!)[\s!?.]*$/i, 'trivial'],
];

const RULES: Array<[RegExp, ContextType]> = [
  ...RAW_RULES.map(([src, ctx]) => [new RegExp(src, 'i'), ctx] as [RegExp, ContextType]),
  ...RAW_RULES_VERBATIM,
];

export function classifyContextRegex(text: string): ContextType[] {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const detected: ContextType[] = [];

  for (const [rx, ctx] of RULES) {
    const target = (ctx === 'math' || ctx === 'trivial') ? text.toLowerCase() : t;
    if (rx.test(target)) detected.push(ctx);
  }

  return detected.length > 0 ? [...new Set(detected)] : ['casual'];
}

export async function classifyContextWithL4(
  text: string,
  userId: string
): Promise<ContextType[]> {
  const regexContexts = classifyContextRegex(text);

  if (regexContexts.includes('math') || regexContexts.includes('trivial')) {
    return regexContexts;
  }

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

  return regexContexts;
}

export function routeModel(
  contexts: ContextType[],
  emotionalScore: number,
  topicEmotionalDimension?: number
): { model: string; label: string } {
  if (emotionalScore > 0.7) return { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet' };
  if (topicEmotionalDimension && topicEmotionalDimension > 0.7) return { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet' };

  const flashFriendly: ContextType[] = [
    'esporte', 'noticias', 'clima', 'casual', 'rotina',
    'alias', 'preferencia', 'recomendacao', 'math', 'trivial', 'compras',
  ];
  if (contexts.includes('agenda') && emotionalScore < 0.4) return { model: 'google/gemini-2.0-flash-001', label: 'flash' };
  if (contexts.some(c => flashFriendly.includes(c))) return { model: 'google/gemini-2.0-flash-001', label: 'flash' };

  const complex: ContextType[] = [
    'agenda', 'projeto', 'familia', 'emocao', 'diario',
    'meta', 'saude', 'evento', 'financas',
  ];
  if (contexts.some(c => complex.includes(c)) && emotionalScore >= 0.4) return { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet' };

  return { model: 'google/gemini-2.0-flash-001', label: 'flash' };
}

export function getTemperature(contexts: ContextType[]): number {
  if (contexts.some((c) => ['emocao', 'diario'].includes(c))) return 0.9;
  if (contexts.some((c) => ['casual', 'projeto', 'familia', 'meta', 'esporte', 'trivial'].includes(c))) return 0.7;
  if (contexts.some((c) => ['rotina', 'alias', 'preferencia', 'recomendacao', 'noticias', 'clima', 'math', 'compras'].includes(c))) return 0.5;
  if (contexts.some((c) => ['agenda', 'evento', 'email', 'saude', 'financas'].includes(c))) return 0.3;
  return 0.7;
}

export function planContextualBlocks(contexts: ContextType[]) {
  const has = (...ctxs: ContextType[]) => ctxs.some(c => contexts.includes(c));
  const isTrivial = has('math', 'trivial');
  const isCasualOnly = contexts.length === 1 && contexts[0] === 'casual';

  const hasEmotional     = has('emocao');
  const hasPlanning      = has('agenda', 'evento', 'meta', 'projeto');
  const hasFinancial     = has('financas');
  const hasShopping      = has('compras');
  const hasProject       = has('projeto');
  const needsMemory      = hasEmotional || has('diario', 'familia', 'saude') || hasFinancial;
  const needsLongTerm    = has('diario', 'emocao');

  return {
    // ── Blocos de conteúdo externo ──────────────────────────────
    loadCalendar:        has('agenda', 'evento', 'familia') && !isTrivial,
    loadEmail:           has('email') && !isTrivial,

    // ── Blocos do dossiê e memória ──────────────────────────────
    loadL3:              !isTrivial && (hasPlanning || hasEmotional || hasFinancial || has('familia', 'saude', 'projeto')),
    loadHD:              needsMemory && !isTrivial && !isCasualOnly,
    loadAshes:           needsLongTerm && !isTrivial,

    // ── Blocos gerados ──────────────────────────────────────────
    loadTopics:          has('saude', 'projeto', 'familia', 'casual', 'rotina', 'preferencia', 'esporte', 'noticias', 'clima', 'compras') && !isTrivial,
    loadDiary:           has('diario', 'meta', 'emocao', 'casual') && !isTrivial,
    loadRecommendations: has('recomendacao', 'casual') && !isTrivial,
    loadGaps:            (hasPlanning || hasEmotional || hasFinancial) && !isTrivial,

    // ── Condicionais novos — alimentam o buildProfileBlock ──────
    loadFinances:        hasFinancial && !isTrivial,   // sectionFinancas()
    loadProjects:        hasProject && !isTrivial,     // sectionProjetos()
    loadShopping:        hasShopping && !isTrivial,    // sectionCompras() já é fixo, mas sinaliza
    loadPlaces:          (hasShopping || has('rotina', 'recomendacao')) && !isTrivial, // sectionLugaresPreferidos()
  };
}
