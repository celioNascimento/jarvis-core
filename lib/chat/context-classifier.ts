// lib/chat/context-classifier.ts
import { supabase } from '@/lib/jarvis';

export type ContextType =
  | 'agenda' | 'projeto' | 'familia' | 'emocao' | 'diario'
  | 'meta' | 'saude' | 'recomendacao' | 'evento' | 'rotina'
  | 'preferencia' | 'alias' | 'email' | 'casual' | 'esporte'
  | 'noticias' | 'clima';

const RULES: Array<[RegExp, ContextType]> = [
  [/diario|diário|hoje foi|hoje ta|hoje está|acordei|dormi|dormir|meu dia|como foi meu|reflexao|refletindo|gratid/i, 'diario'],
  [/meta|objetivo|quero (conseguir|fazer|terminar|lancar|comecar)|prazo|progresso|etapa|concluir|finalizar/i, 'meta'],
  [/reuniao|reunião|consulta|compromisso|agend|horario|horário|amanha as|amanhã às|segunda|terça|quarta|quinta|sexta|sabado|domingo|às \d|as \d{1,2}h/i, 'agenda'],
  [/projeto|app|aplicativo|sistema|api|deploy|feature|sprint|mvp|startup|produto|desenvolv/i, 'projeto'],
  [/filho|filha|esposa|marido|mae|mãe|pai|irmao|irmão|família|familia|cônjuge|conjuge|casamento|nasceu|aniversario de casamento/i, 'familia'],
  [/medic|médic|saude|saúde|exame|remedio|remédio|hospital|dor|doenca|doença|sintoma|consulta médica/i, 'saude'],
  [/sinto|estou (triste|feliz|ansioso|cansado|animado|frustrado|preocupado|deprimido|sozinho)|me sinto|to mal|tô mal|to bem|tô bem|angustia|angústia|estressado/i, 'emocao'],
  [/email|e-mail|inbox|caixa de entrada|mensagem do|mensagem da|enviou|recebeu/i, 'email'],
  [/indica|recomend|sugere|onde posso|tem algum|onde tem|restaurante|lugar|lugar bom|conhece algum/i, 'recomendacao'],
  [/aniversario|aniversário|natal|pascoa|páscoa|ano novo|feriado|data importante|comemora/i, 'evento'],
  [/acordo|desperto|academia|treino|trabalho as|trabalho às|entrada no trabalho|saida do trabalho|rotina|horario de/i, 'rotina'],
  [/gosto de|nao gosto de|não gosto de|prefiro|adoro|odeio|minha comida|meu filme|minha musica|minha música/i, 'preferencia'],
  [/quando falo em|quando eu falar|pode chamar de|se eu disser|apelido|alias/i, 'alias'],
  [/jogo|partida|futebol|basquete|vôlei|volei|tenis|f1|corrida|campeonato|copa|campeonato brasileiro|libertadores|copa do brasil|série a|série b|classificação|tabela|artilheiro|resultado|placar|hoje tem jogo|quando é o jogo|proximo jogo|próximo jogo|data do jogo|horário do jogo|escalação/i, 'esporte'],
  [/noticia|notícias|últimas|recente|aconteceu|hoje no|manchete|jornal|portal|g1|globo|folha|estadão/i, 'noticias'],
  [/clima|tempo|temperatura|chuva|frio|calor|previsão|amanhecer|entardecer|umidade|vento|chover|chuvoso/i, 'clima'],
];

export function classifyContextRegex(text: string): ContextType[] {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const detected: ContextType[] = [];
  for (const [rx, ctx] of RULES) {
    if (rx.test(t)) detected.push(ctx);
  }
  return detected.length > 0 ? detected : ['casual'];
}

export async function classifyContextWithL4(
  text: string,
  userId: string
): Promise<ContextType[]> {
  const regexContexts = classifyContextRegex(text);

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

// NOVO: routeModel agora recebe emotionalScore e topicEmotionalDimension
export function routeModel(
  contexts: ContextType[],
  emotionalScore: number,
  topicEmotionalDimension?: number
): { model: string; label: string } {
  // Se o score emocional for muito alto, vai direto para Sonnet
  if (emotionalScore > 0.7) {
    return { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet' };
  }

  // Se o tópico tem dimensão emocional alta, prioriza Sonnet
  if (topicEmotionalDimension && topicEmotionalDimension > 0.7) {
    return { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet' };
  }

  // Tópicos que podem ir para Flash com baixo score emocional
  const flashFriendly: ContextType[] = ['esporte', 'noticias', 'clima', 'casual', 'rotina', 'alias', 'preferencia', 'recomendacao'];
  // Agenda pode ir para Flash se score < 0.4
  if (contexts.includes('agenda') && emotionalScore < 0.4) {
    return { model: 'google/gemini-2.0-flash-001', label: 'flash' };
  }

  if (contexts.some(c => flashFriendly.includes(c))) {
    return { model: 'google/gemini-2.0-flash-001', label: 'flash' };
  }

  // Tópicos complexos ou emocionais que devem ir para Sonnet se score médio-alto
  const complex: ContextType[] = [
    'agenda', 'projeto', 'familia', 'emocao', 'diario',
    'meta', 'saude', 'evento'
  ];
  if (contexts.some(c => complex.includes(c)) && emotionalScore >= 0.4) {
    return { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet' };
  }

  // Fallback: Flash para economia
  return { model: 'google/gemini-2.0-flash-001', label: 'flash' };
}

export function getTemperature(contexts: ContextType[]): number {
  if (contexts.some((c) => ['emocao', 'diario'].includes(c))) return 0.9;
  if (contexts.some((c) => ['casual', 'projeto', 'familia', 'meta', 'esporte'].includes(c))) return 0.7;
  if (contexts.some((c) => ['rotina', 'alias', 'preferencia', 'recomendacao', 'noticias', 'clima'].includes(c))) return 0.5;
  if (contexts.some((c) => ['agenda', 'evento', 'email', 'saude'].includes(c))) return 0.3;
  return 0.7;
}

export function planContextualBlocks(contexts: ContextType[]) {
  return {
    loadTopics: contexts.some((c) =>
      ['saude', 'projeto', 'familia', 'casual', 'rotina', 'preferencia', 'esporte', 'noticias', 'clima'].includes(c)
    ),
    loadDiary: contexts.some((c) => ['diario', 'meta', 'emocao', 'casual'].includes(c)),
    loadRecommendations: contexts.some((c) => ['recomendacao', 'casual'].includes(c)),
    loadCalendar: contexts.some((c) => ['agenda', 'evento', 'familia'].includes(c)),
    loadEmail: contexts.some((c) => ['email'].includes(c)),
  };
}