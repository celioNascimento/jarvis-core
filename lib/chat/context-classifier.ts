// lib/chat/context-classifier.ts
import { supabase } from '@/lib/jarvis';

export type ContextType =
  | 'agenda' | 'projeto' | 'familia' | 'emocao' | 'diario'
  | 'meta' | 'saude' | 'recomendacao' | 'evento' | 'rotina'
  | 'preferencia' | 'alias' | 'email' | 'casual' | 'esporte'
  | 'noticias' | 'clima' | 'financas' | 'compras'
  | 'math' | 'trivial';

// Normaliza uma string removendo acentos (idêntico ao que classifyContextRegex faz com o input)
function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Compila as regexes já normalizadas UMA VEZ no load do módulo.
// Assim não há custo de normalização por request, e as regexes batem
// corretamente com o texto do usuário que também é normalizado.
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

// Regras que NÃO passam por normalização de acento (math/trivial operam sobre o texto original)
const RAW_RULES_VERBATIM: Array<[RegExp, ContextType]> = [
  [/^[0-9+\-*/%() ]+$/, 'math'],
  [/quanto [eé]|quanto d[aá]|calcule|soma|subtraia|multiplique|divida|raiz|pot[eê]ncia|^[0-9]+ (mais|vezes|dividido por|menos) [0-9]+/i, 'math'],
  [/^(ok|oi|ol[aá]|bom dia|boa tarde|boa noite|tudo bem|tudo bom|blz|vlw|valeu|obrigad|kkk|haha|rs|👍|🙏|😂|!)[\s!?.]*$/i, 'trivial'],
];

// Compilado uma vez — zero custo em runtime
const RULES: Array<[RegExp, ContextType]> = [
  ...RAW_RULES.map(([src, ctx]) => [new RegExp(src, 'i'), ctx] as [RegExp, ContextType]),
  ...RAW_RULES_VERBATIM,
];

export function classifyContextRegex(text: string): ContextType[] {
  // Normalização feita uma única vez para todas as regras acento-normalizadas
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const detected: ContextType[] = [];

  for (const [rx, ctx] of RULES) {
    // math/trivial testam o texto original para preservar símbolos como ^, +, etc.
    const target = (ctx === 'math' || ctx === 'trivial') ? text.toLowerCase() : t;
    if (rx.test(target)) detected.push(ctx);
  }

  // Remove duplicatas mantendo ordem (Set preserva insertion order)
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
  const hasEmotional   = contexts.includes('emocao');
  const hasSearch      = contexts.includes('esporte') || contexts.includes('noticias') || contexts.includes('clima');
  const hasPlanning    = contexts.includes('agenda') || contexts.includes('evento') || contexts.includes('meta') || contexts.includes('projeto');
  const hasFinancial   = contexts.includes('financas');
  const hasShopping    = contexts.includes('compras');
  const isCasualOnly   = contexts.length === 1 && contexts[0] === 'casual';
  const isTrivial      = contexts.includes('math') || contexts.includes('trivial');
  const needsMemory    = hasEmotional || contexts.includes('diario') || contexts.includes('familia') || contexts.includes('saude') || hasFinancial;
  const needsLongTerm  = contexts.includes('diario') || contexts.includes('emocao');

  return {
    loadTopics: contexts.some((c) =>
      ['saude', 'projeto', 'familia', 'casual', 'rotina', 'preferencia',
       'esporte', 'noticias', 'clima', 'compras'].includes(c)
    ) && !isTrivial,
    loadDiary:           contexts.some((c) => ['diario', 'meta', 'emocao', 'casual'].includes(c)) && !isTrivial,
    loadRecommendations: contexts.some((c) => ['recomendacao', 'casual'].includes(c)) && !isTrivial,
    loadCalendar:        contexts.some((c) => ['agenda', 'evento', 'familia'].includes(c)) && !isTrivial,
    loadEmail:           contexts.includes('email') && !isTrivial,
    loadL3: !isTrivial && (
      hasPlanning || hasEmotional || hasFinancial ||
      contexts.includes('familia') || contexts.includes('saude') || contexts.includes('projeto')
    ),
    loadHD:       needsMemory && !isTrivial && !isCasualOnly,
    loadAshes:    needsLongTerm && !isTrivial && (contexts.includes('diario') || contexts.includes('emocao')),
    loadGaps:     (hasPlanning || hasEmotional || hasFinancial) && !isTrivial,
    loadFinances: hasFinancial && !isTrivial,
    loadShopping: hasShopping && !isTrivial,
  };
}
