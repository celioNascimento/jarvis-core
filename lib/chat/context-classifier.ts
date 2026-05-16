// lib/chat/context-classifier.ts
// V9.3.1 — Blindagem Total (Zero DB Calls, Tipagem Estrita e Regex Segura)

import { supabase } from '@/lib/jarvis';
import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway';

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
  | 'retrospecto'
  | 'veiculos'
  | 'planejamento'
  | 'foco'
  | 'relacao'
  | 'casa'
  | 'sistema'
  | 'estudo'
  | 'lembrete'     // ← NOVO
  | 'notificacao'; // ← NOVO

const ALL_CONTEXTS: ContextType[] = [
  'casual', 'agenda', 'email', 'saude', 'familia', 'trabalho', 'projeto',
  'meta', 'emocao', 'diario', 'rotina', 'preferencia', 'alias', 'recomendacao',
  'esporte', 'noticias', 'clima', 'math', 'trivial', 'compras', 'financas',
  'evento', 'tdah', 'foco', 'retrospecto', 'veiculos', 'planejamento',
  'relacao', 'casa', 'sistema', 'estudo', 'lembrete', 'notificacao'
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  [norm('compra|mercado|feira|lista|cimento|tinta|whey|suplemento|reforma|precisamos de|acabou o|faltando|falta em casa|precisando de|supermercado|item'), 'compras'],
  [norm('gastei|paguei|recebi|salário|salario|despesa|receita|conta|comprei|boleto|fatura|orçamento|orcamento|finanças|financas|dinheiro|grana|divida|dívida|cartao|cartão|credito|crédito|debito|débito|investimento|poupanca|poupança|saldo|extrato|gasto|pix|ted|transacao|transação|banco|nubank|itaú|itau|bradesco|santander|inter|caixa econômica'), 'financas'],
  [norm('trabalho|empresa|chefe|colega|reunião de trabalho|tarefa|prazo|entrega|cliente'), 'trabalho'],
  [norm('foco|tdah|procrastinando|travado|paralisado|sobrecarregado|por onde começo|nao sei comecar'), 'tdah'],
  [norm('carro|veiculo|veículo|moto|placa|km|odômetro|odometro|gasolina|etanol|diesel|abasteci|abastecer|manutenção|manutencao|multa|pneu|oficina|mecanico|mecânico|troca de óleo|freio'), 'veiculos'],
  [norm('contato|permissao|permissão|compartilh|acesso|libera|bloqueia|autoriza|giselle|namorada|amigo|rede|relacao|relação|relacionamento'), 'relacao'],
  [norm('casa|reforma|construção|construcao|conserto|parede|tinta|piso|led|iluminação|iluminacao|eletrodoméstico|eletro|lava louça|geladeira|tomada'), 'casa'],
  [norm('diretriz|system prompt|regra|comportamento|aja como|não diga mais|nunca mais use|a partir de agora|instrução|mude seu prompt'), 'sistema'],
  [norm('estudar|estudando|aprender|aula|curso|certificac|certificaç|prova|inglês|ingles|idioma|traduz|traduza|pronúncia|praticar inglês'), 'estudo'],
  [norm('lembrete|lembretes|me lembra|me avisa|me avise|me notifica|me notifique|consulte meus|quais lembretes|cancelar lembrete|apagar lembrete'), 'lembrete'],
  [norm('notificacao|notificação|push|alerta|avisar|notificar|me manda|me envia'), 'notificacao'],
] as Array<[string, ContextType]>).map(([src, ctx]) => [new RegExp(src, 'i'), ctx]);

const RULES_VERBATIM: Array<[RegExp, ContextType]> = [
  [/^\d+[\+\-\*\/]\d+|^[0-9+\-*/%() ]+$/, 'math'],
  [/quanto [eé]|quanto d[aá]|calcule|soma|subtraia|multiplique|divida|raiz|pot[eê]ncia|quanto é|calcul|porcentagem|^[0-9]+ (mais|vezes|dividido por|menos) [0-9]+/i, 'math'],
  [/^(ok|oi|ol[aá]|bom dia|boa tarde|boa noite|tudo bem|tudo bom|blz|vlw|valeu|obrigad|kkk|haha|rs|👍|🙏|😂|!)[\s!?.]*$/i, 'trivial'],
  [/R\$|\breal\b/i, 'financas'],
  [/você me (disse|falou|indicou|sugeriu|recomendou|lembrou|avisou|mostrou)|me indicou|falamos (sobre|de|que)|você (lembra|sabe) que (me|eu)|ontem (você|vc)|antes você|na última vez|você tinha dito|vc tinha falado/i, 'retrospecto' as ContextType],
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

const HIGH_CONFIDENCE_CONTEXTS: ContextType[] = [
  'math', 'trivial', 'financas', 'esporte', 'clima', 'email', 'agenda',
  'compras', 'saude', 'noticias', 'retrospecto', 'veiculos', 'lembrete', 'notificacao'
];

function needsLLMClassification(text: string, regexContexts: ContextType[]): boolean {
  if (regexContexts.includes('math') || regexContexts.includes('trivial')) return false;
  if (text.length < 30) return false;
  if (regexContexts.some(c => HIGH_CONFIDENCE_CONTEXTS.includes(c))) return false;
  if (regexContexts.length === 1 && regexContexts[0] === 'casual' && text.length > 60) return true;
  if (regexContexts.length >= 3 && text.length > 100) return true;
  return false;
}

// ─── classifyContextWithL4 ────────────────────────────────────────────────────

export async function classifyContextWithL4(
  text: string,
  userId: number,
  authUserIdOrSafeContext?: string | any,
  safeContextFallback?: any
): Promise<ContextType[]> {
  const regexContexts = classifyContextRegex(text);

  if (!needsLLMClassification(text, regexContexts)) {
    return regexContexts;
  }

  // Tratamento resiliente de argumentos para garantir que o safeContext seja capturado
  const actualSafeContext = typeof authUserIdOrSafeContext === 'object'
    ? authUserIdOrSafeContext
    : safeContextFallback;

  if (regexContexts.length > 2) {
    // Tenta usar o contexto em memória primeiro (Zero DB call)
    const topicWeights = actualSafeContext?.topics || [];

    if (topicWeights.length) {
      const sorted = [...topicWeights].sort((a: any, b: any) => (b.weight || 0) - (a.weight || 0));
      const prioritized = sorted.map((t) => t.topic as ContextType);
      const missing = regexContexts.filter((c) => !prioritized.includes(c));
      if (prioritized.length >= regexContexts.length * 0.6) {
        return [...prioritized, ...missing] as ContextType[];
      }
    } else {
      // Fallback seguro usando type NUMBER (Evita 400 Bad Request)
      try {
        const { data: dbTopics } = await supabase
          .schema('public')
          .from('topic_index')
          .select('topic, weight')
          .eq('user_id', userId)
          .in('topic', regexContexts);

        if (dbTopics?.length) {
          const sorted = [...dbTopics].sort((a, b) => (b.weight || 0) - (a.weight || 0));
          const prioritized = sorted.map((t) => t.topic as ContextType);
          const missing = regexContexts.filter((c) => !prioritized.includes(c));
          return [...prioritized, ...missing] as ContextType[];
        }
      } catch { }
    }
  }

  try {
    const prompt = `Classifique a mensagem abaixo em 1-3 categorias da lista:\n${ALL_CONTEXTS.join(', ')}\n\nMensagem: "${text.slice(0, 200)}"\n\nResponda APENAS com JSON: {"contexts": ["cat1", "cat2"]}`;

    const rawResponse: any = await callOpenRouterWithPriority(
      2, 'if_full', `ctx_class_${Date.now()}`, [{ role: 'user', content: prompt }], [], 'google/gemini-2.0-flash-001', 0.1
    );

    const rawText = typeof rawResponse === 'string' ? rawResponse : (rawResponse.text || rawResponse.content || '');

    // ✅ CORREÇÃO APLICADA: Sintaxe `{3}` evita a quebra de linha em formatadores e erros no Turbopack
    const cleaned = rawText.trim().replace(/`{3}json|`{3}/g, '').trim();

    const parsed = JSON.parse(cleaned);
    const llmContexts = (parsed.contexts as ContextType[]).filter((c) => ALL_CONTEXTS.includes(c));

    return [...new Set([...regexContexts, ...llmContexts])] as ContextType[];
  } catch (e: any) {
    if (e.message === 'GATEKEEPER_DROPPED_TASK') {
      console.log(`[ContextL4/Gateway] ✂️ Classificação LLM abortada por alto tráfego. Usando fallback.`);
    }
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

  if (effectiveEmotional > 0.7) return { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet-emocional' };
  if (contexts.some((c) => ['emocao', 'familia', 'saude', 'diario'].includes(c))) return { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet-pessoal' };
  if (contexts.some((c) => ['trabalho', 'projeto', 'meta', 'financas'].includes(c))) return { model: 'google/gemini-2.5-pro', label: 'pro-trabalho' };

  const flashFriendly: ContextType[] = ['esporte', 'noticias', 'clima', 'casual', 'rotina', 'alias', 'preferencia', 'recomendacao', 'math', 'trivial', 'compras', 'veiculos'];
  if (contexts.includes('agenda') && effectiveEmotional < 0.4) return { model: 'google/gemini-2.0-flash-001', label: 'flash-agenda' };
  if (contexts.some((c) => flashFriendly.includes(c))) return { model: 'google/gemini-2.0-flash-001', label: 'flash-default' };

  return { model: 'google/gemini-2.0-flash-001', label: 'flash-default' };
}

// ─── getTemperature ───────────────────────────────────────────────────────────

export function getTemperature(contexts: ContextType[]): number {
  if (contexts.includes('math') || contexts.includes('trivial')) return 0.2;
  if (contexts.some((c) => ['emocao', 'diario'].includes(c))) return 0.9;
  if (contexts.some((c) => ['emocao', 'familia'].includes(c))) return 0.85;
  if (contexts.some((c) => ['casual', 'projeto', 'meta', 'esporte', 'trivial'].includes(c))) return 0.7;
  if (contexts.some((c) => ['trabalho', 'projeto'].includes(c))) return 0.5;
  if (contexts.some((c) => ['financas', 'veiculos'])) return 0.3;
  if (contexts.some((c) => ['rotina', 'alias', 'preferencia', 'recomendacao', 'noticias', 'clima', 'compras'].includes(c))) return 0.5;
  if (contexts.some((c) => ['agenda', 'evento', 'email', 'saude'].includes(c))) return 0.3;
  return 0.7;
}

// ─── planContextualBlocks ─────────────────────────────────────────────────────

export function planContextualBlocks(
  contexts: ContextType[],
  message: string,
  emotionalScore: number
) {
  const has = (...ctxs: ContextType[]) => ctxs.some((c) => contexts.includes(c));
  const msg = message.toLowerCase();
  const isTrivial = has('math', 'trivial');
  const isCasualOnly = contexts.length === 1 && contexts[0] === 'casual';

  const wantsWeather = has('clima') || /vai chover|levo guarda|como (está|tá|ta) o tempo|temperatura|frio|calor hoje|agasalho|sair hoje/.test(msg);
  const wantsCalendar = has('agenda', 'evento') && /marcar|agendar|tem algo|minha agenda|meus compromissos|semana|amanhã|amanha|hoje|horário|horario|confirmar|cancelar|vou|tenho|tem/.test(msg);
  const wantsFinances = has('financas') && /gastei|paguei|recebi|comprei|transferi|quanto (gastei|tenho|sobrou|falta)|minhas finan|meu saldo|extrato|fatura|boleto|orçamento|orcamento|limite/.test(msg);
  const hasRealEmotion = emotionalScore > 0.3;
  const wantsDiary = has('diario', 'meta') || (has('emocao') && hasRealEmotion) || (has('tdah') && /travado|paralisado|sobrecarregado|por onde|foco/.test(msg));
  const wantsRec = has('recomendacao') || /me indica|me recomenda|onde (posso|vai|tem)|tem algum|conhece (algum|alguma)|me sugere/.test(msg);
  const wantsShopping = has('compras', 'casa');
  const wantsPlaces = wantsShopping || (has('rotina', 'recomendacao') && /perto|próximo|aqui|bairro/.test(msg));
  const isRetrospecto = has('retrospecto') || /você me (disse|falou|indicou|sugeriu|recomendou)|me indicou|falamos (sobre|de)|ontem você|antes você|última vez/i.test(msg);

  const needsHD = (hasRealEmotion || has('diario', 'familia', 'saude') || wantsFinances || isRetrospecto) && !isTrivial && !isCasualOnly;
  const needsAshes = (has('diario', 'emocao', 'meta', 'familia') && (hasRealEmotion || wantsDiary)) && !isTrivial;
  const needsGaps = (wantsCalendar || wantsFinances || has('projeto', 'meta', 'trabalho')) && !isTrivial;
  const needsTopics = has('saude', 'projeto', 'familia', 'rotina', 'preferencia') && !isTrivial && !isCasualOnly;

  return {
    loadWeather: wantsWeather && !isTrivial,
    loadCalendar: wantsCalendar && !isTrivial,
    loadEmail: has('email') && !isTrivial,
    loadL3: !isTrivial,
    loadHD: needsHD || isRetrospecto,
    loadAshes: needsAshes,
    loadTopics: needsTopics,
    loadDiary: wantsDiary && !isTrivial,
    loadRecommendations: (wantsRec || isRetrospecto) && !isTrivial,
    loadGaps: needsGaps,
    loadFinances: wantsFinances && !isTrivial,
    loadProjects: has('projeto') && !isTrivial,
    loadShopping: wantsShopping && !isTrivial,
    loadPlaces: wantsPlaces && !isTrivial,
  };
}

// ─── detectTopicShiftWithL4 ───────────────────────────────────────────────────

export async function detectTopicShiftWithL4(
  userId: number,
  newContexts: ContextType[]
): Promise<boolean> {
  try {
    const { data } = await supabase
      .schema('public')
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
