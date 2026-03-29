// app/api/chat/route.ts
// Motor V8 Unificado — Arquitetura Dual-ID: Separação cirúrgica entre Auth UUID (brain, lugares) e Numeric ID (events, goals)
// CORREÇÕES APLICADAS:
//   1. users lookup aceita userId OU email (fallback robusto, não quebra clientes antigos)
//   2. pending_question restaurado (campo consultado direto da tabela users)
//   3. API key corrigida: OPENROUTER_API_KEY para chamadas ao OpenRouter
//   4. Imports restaurados: setPendingQuestion, clearPendingQuestion, getPendingQuestion
//   5. [NOVO] shouldForceSearch agora checa o banco vetorial antes de acionar a web.
//   6. [NOVO] Correção rigorosa de tipagem (UUID vs BIGINT) nas chamadas de extração e memória.

import { NextRequest, NextResponse } from 'next/server';
import {
  supabase,
  callOpenRouter,
  generateEmbedding,
  compactMemory,
  getOrCreateSession,
  reinforceMemory,
  getPendingQuestion,
  setPendingQuestion,
  clearPendingQuestion,
} from '@/lib/jarvis';
import {
  getRecentEmails,
  getMicrosoftCalendarContext,
} from '@/lib/microsoft';
import {
  getGoogleContext,
  searchWeb,
  getWeatherForecast,
} from '@/lib/google';
import { checkProximidade } from '@/lib/geo';
import { verificarAlertasDeProximidade } from '@/lib/geo-alerts';
import {
  classifyTemporalHorizon,
  truncateByWeight,
} from '@/lib/context-router';
import {
  initOnboarding,
  processOnboardingFromMessage,
  buildOnboardingBlock,
} from '@/lib/onboarding';
import { extractAndSummarize, buildGapsBlock } from '@/lib/extractor';
import {
  upsertEvent,
  buildRecommendationsBlock,
  buildTopicBlock,
  extractRecomendacao,
} from '@/lib/extractor-jobs';
import {
  extractDiary,
  extractGoal,
  buildDiaryGoalsBlock,
  updateGoalProgress,
} from '@/lib/diary';

export const maxDuration = 30;

// ============================================================
// Cache de embeddings
// ============================================================
const embeddingCache = new Map<string, number[]>();
async function getCachedEmbedding(text: string): Promise<number[]> {
  if (embeddingCache.has(text)) return embeddingCache.get(text)!;
  const embedding = await generateEmbedding(text);
  embeddingCache.set(text, embedding);
  return embedding;
}

// ============================================================
// Atualiza relevância dos eventos (decay)
// ============================================================
async function updateEventRelevance(userId: string) {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const { data: events } = await supabase
    .from('events')
    .select('id, title, event_date, decay_type, relevance_score')
    .eq('user_id', userId);
  if (!events) return;
  const updates = [];
  for (const ev of events) {
    const eventDate = new Date(ev.event_date);
    eventDate.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil(
      (eventDate.getTime() - hoje.getTime()) / (1000 * 3600 * 24)
    );
    let newScore = 0;
    switch (ev.decay_type) {
      case 'recurring_annual':
        if (diffDays < -30) newScore = 0;
        else if (diffDays <= 0) newScore = 0.9 + (diffDays === 0 ? 0.1 : 0);
        else if (diffDays <= 30) newScore = 0.3 + 0.6 * (1 - diffDays / 30);
        else newScore = 0;
        break;
      case 'deadline':
        if (diffDays < -7) newScore = 0;
        else if (diffDays <= 0) newScore = 0.9 + (diffDays === 0 ? 0.1 : 0);
        else if (diffDays <= 7) newScore = 0.3 + 0.6 * (1 - diffDays / 7);
        else newScore = 0;
        break;
      case 'one_time':
        if (diffDays < -14) newScore = 0;
        else if (diffDays <= 0) newScore = 0.9 + (diffDays === 0 ? 0.1 : 0);
        else if (diffDays <= 14) newScore = 0.2 + 0.7 * (1 - diffDays / 14);
        else newScore = 0;
        break;
      default:
        if (diffDays < 0)
          newScore = Math.max(0, (ev.relevance_score || 0) * 0.95);
        else newScore = ev.relevance_score || 0;
    }
    newScore = Math.min(0.95, Math.max(0, newScore));
    if (Math.abs(newScore - (ev.relevance_score || 0)) > 0.01) {
      updates.push({ id: ev.id, relevance_score: newScore });
    }
  }
  if (updates.length) {
    for (const upd of updates) {
      await supabase
        .from('events')
        .update({ relevance_score: upd.relevance_score })
        .eq('id', upd.id);
    }
    console.log(`[Eventos] Atualizadas relevâncias de ${updates.length} eventos`);
  }
}

// ============================================================
// Health check para L3/L4
// ============================================================
async function ensureMemoryHealth(userId: string) {
  try {
    await updateEventRelevance(userId);
    const { data: topics } = await supabase
      .from('topic_index')
      .select('id, weight')
      .eq('user_id', userId)
      .lt(
        'last_mentioned',
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      );
    if (topics && topics.length) {
      for (const topic of topics) {
        const newWeight = (topic.weight || 0) * 0.95;
        await supabase
          .from('topic_index')
          .update({ weight: newWeight })
          .eq('id', topic.id);
      }
      console.log(`[Health] Decaimento L4: ${topics.length} tópicos atualizados`);
    }
  } catch (e) {
    console.error('[Health] Erro no health check:', e);
  }
}

// ============================================================
// Classificação de contexto — com esporte, noticias, clima
// ============================================================
type ContextType =
  | 'agenda'
  | 'projeto'
  | 'familia'
  | 'emocao'
  | 'diario'
  | 'meta'
  | 'saude'
  | 'recomendacao'
  | 'evento'
  | 'rotina'
  | 'preferencia'
  | 'alias'
  | 'email'
  | 'casual'
  | 'esporte'
  | 'noticias'
  | 'clima';

function classifyContextRegex(text: string): ContextType[] {
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const rules: Array<[RegExp, ContextType]> = [
    [
      /diario|diário|hoje foi|hoje ta|hoje está|acordei|dormi|dormir|meu dia|como foi meu|reflexao|refletindo|gratid/i,
      'diario',
    ],
    [
      /meta|objetivo|quero (conseguir|fazer|terminar|lancar|comecar)|prazo|progresso|etapa|concluir|finalizar/i,
      'meta',
    ],
    [
      /reuniao|reunião|consulta|compromisso|agend|horario|horário|amanha as|amanhã às|segunda|terça|quarta|quinta|sexta|sabado|domingo|às \d|as \d{1,2}h/i,
      'agenda',
    ],
    [
      /projeto|app|aplicativo|sistema|api|deploy|feature|sprint|mvp|startup|produto|desenvolv/i,
      'projeto',
    ],
    [
      /filho|filha|esposa|marido|mae|mãe|pai|irmao|irmão|família|familia|cônjuge|conjuge|casamento|nasceu|aniversario de casamento/i,
      'familia',
    ],
    [
      /medic|médic|saude|saúde|exame|remedio|remédio|hospital|dor |doenca|doença|sintoma|consulta médica/i,
      'saude',
    ],
    [
      /sinto|estou (triste|feliz|ansioso|cansado|animado|frustrado|preocupado|deprimido|sozinho)|me sinto|to mal|tô mal|to bem|tô bem|angustia|angústia|estressado/i,
      'emocao',
    ],
    [
      /email|e-mail|inbox|caixa de entrada|mensagem do|mensagem da|enviou|recebeu/i,
      'email',
    ],
    [
      /indica|recomend|sugere|onde posso|tem algum|onde tem|restaurante|lugar|lugar bom|conhece algum/i,
      'recomendacao',
    ],
    [
      /aniversario|aniversário|natal|pascoa|páscoa|ano novo|feriado|data importante|comemora/i,
      'evento',
    ],
    [
      /acordo|desperto|academia|treino|trabalho as|trabalho às|entrada no trabalho|saida do trabalho|rotina|horario de/i,
      'rotina',
    ],
    [
      /gosto de|nao gosto de|não gosto de|prefiro|adoro|odeio|minha comida|meu filme|minha musica|minha música/i,
      'preferencia',
    ],
    [
      /quando falo em|quando eu falar|pode chamar de|se eu disser|apelido|alias/i,
      'alias',
    ],
    [
      /jogo|partida|futebol|basquete|vôlei|volei|tenis|f1|corrida|campeonato|copa|campeonato brasileiro|libertadores|copa do brasil|série a|série b|classificação|tabela|artilheiro|resultado|placar|hoje tem jogo|quando é o jogo|proximo jogo|próximo jogo|data do jogo|horário do jogo|escalação/i,
      'esporte',
    ],
    [
      /noticia|notícias|últimas|recente|aconteceu|hoje no|manchete|jornal|portal|g1|globo|folha|estadão/i,
      'noticias',
    ],
    [
      /clima|tempo|temperatura|chuva|frio|calor|previsão|amanhecer|entardecer|umidade|vento|chover|chuvoso/i,
      'clima',
    ],
  ];
  const detected: ContextType[] = [];
  for (const [rx, ctx] of rules) {
    if (rx.test(t)) detected.push(ctx);
  }
  return detected.length > 0 ? detected : ['casual'];
}

async function classifyContextWithL4(
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
    if (topicWeights && topicWeights.length > 0) {
      const sorted = topicWeights.sort(
        (a, b) => (b.weight || 0) - (a.weight || 0)
      );
      const prioritized = sorted.map((t) => t.topic as ContextType);
      const missing = regexContexts.filter((c) => !prioritized.includes(c));
      return [...prioritized, ...missing];
    }
  }
  return regexContexts;
}

// ============================================================
// Roteamento de modelo e temperatura
// ============================================================
function routeModel(contexts: ContextType[]): { model: string; label: string } {
  const complex: ContextType[] = [
    'agenda', 'projeto', 'familia', 'emocao', 'diario',
    'meta', 'saude', 'esporte', 'noticias', 'clima',
  ];
  return contexts.some((c) => complex.includes(c))
    ? { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet' }
    : { model: 'google/gemini-2.0-flash-001', label: 'flash' };
}

function getTemperature(contexts: ContextType[]): number {
  if (contexts.some((c) => ['emocao', 'diario'].includes(c))) return 0.9;
  if (contexts.some((c) => ['casual', 'projeto', 'familia', 'meta', 'esporte'].includes(c))) return 0.7;
  if (contexts.some((c) => ['rotina', 'alias', 'preferencia', 'recomendacao', 'noticias', 'clima'].includes(c))) return 0.5;
  if (contexts.some((c) => ['agenda', 'evento', 'email', 'saude'].includes(c))) return 0.3;
  return 0.7;
}

function planContextualBlocks(contexts: ContextType[]) {
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

// ============================================================
// Busca forçada (com normalização e VERIFICAÇÃO VETORIAL PRÉVIA)
// ============================================================
async function shouldForceSearch(
  message: string,
  contexts: ContextType[],
  userId: string,
  currentEmbedding: number[]
): Promise<boolean> {
  const lower = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  // REGRA 1 (ALTA PRIORIDADE): Se a frase é sobre o próprio usuário
  const personalKeywords =
    /\b(eu|meu|minha|meus|minhas|comecei|trabalhei|trabalho|nasci|moro|morei|casei|tive|tenho|familia|esposa|marido|filho|filha|minha vida|meu trabalho|minha historia|quando comecei|quando fui|quando entrei)\b/i;
  if (personalKeywords.test(lower)) {
    console.log('[shouldForceSearch] Frase pessoal detectada — usando banco de dados, sem busca web.');
    return false;
  }

  // REGRA 2 (NOVA PROTEÇÃO): Busca Preventiva no Banco de Memórias
  // Evita a 'amnésia' ao perguntar na terceira pessoa (ex: "quando celio roberto...")
  try {
    const { data: localMemories } = await supabase.rpc('match_memories', {
      query_embedding: currentEmbedding,
      match_threshold: 0.55, 
      match_count: 1
    });
    
    if (localMemories && localMemories.length > 0) {
      console.log('[shouldForceSearch] Memória local encontrada! Evitando busca web desnecessária.');
      return false; // Tem a resposta no cérebro, não vai para o Google
    }
  } catch (err) {
    console.error('[shouldForceSearch] Erro ao buscar memória preventiva:', err);
  }

  // REGRA 3: Palavras-chave de domínio externo
  const keywords =
    /\b(jogo|partida|futebol|basquete|volei|tenis|f1|corrida|campeonato|copa|libertadores|copa do brasil|classificacao|tabela|artilheiro|resultado|placar|hoje tem|proximo|escalacao|expo|feira|comeca|inicio|data de|horario de|edicao|noticia|ultimas|recente|aconteceu|clima|temperatura|chuva|chover|previsao|cotacao|preco do|valor do|dolar|euro|bitcoin|ibovespa)\b/i;
  if (keywords.test(lower)) {
    console.log('[shouldForceSearch] Palavra-chave externa detectada, forçando busca');
    return true;
  }

  // REGRA 4: Palavras temporais (agora só ativa se não achou no banco vetorial primeiro)
  if (/(qual e|como esta|como fica|o que aconteceu|o que rolou|vai chover|vai ter|como vai ser|quando)/i.test(lower)) {
    console.log('[shouldForceSearch] Palavra temporal de domínio externo detectada, forçando busca');
    return true;
  }

  console.log('[shouldForceSearch] Nenhum gatilho externo detectado');
  return false;
}

function refineSearchQuery(message: string, contexts: ContextType[]): string {
  let query = message.trim();

  if (contexts.includes('esporte')) {
    const cleanMsg = message.replace(/^(quando é|quando e|qual o|qual e|quem joga|onde e|onde vai ser)\s+/i, '').trim();
    query = `${cleanMsg} 2026`.replace(/\?+/g, '');
    if (!query.toLowerCase().includes('jogo') && !query.toLowerCase().includes('escalação')) {
      if (!query.toLowerCase().includes('próximo') && !query.toLowerCase().includes('data') && !query.toLowerCase().includes('horário')) {
        query = `próximo jogo ${query}`;
      }
    }
  } else if (contexts.includes('evento') && /expo|feira|evento|começa|início/i.test(message)) {
    const currentYear = new Date().getFullYear();
    query = `${message} ${currentYear}`.replace(/\?+/g, '');
  } else if (contexts.includes('clima')) {
    const locationMatch = message.match(/(em|no|na) (.*?)(?:\?|$)/i);
    if (locationMatch && locationMatch[2].trim().length < 30) {
      query = `clima ${locationMatch[2].trim()}`;
    } else {
      query = `clima ${message}`.replace(/\?+/g, '');
    }
  } else if (contexts.includes('noticias') && !/(notícia|notícias)/i.test(query)) {
    query = `últimas notícias ${query}`;
  }

  return query.trim();
}

// ============================================================
// Topic Index (L4) e RAM
// ============================================================
async function updateTopicIndex(userId: string, contexts: string[], messageText: string) {
  if (!contexts.length) return;
  const words = messageText.toLowerCase().split(/\s+/);
  const keyTerms = words.filter((w) => w.length > 3 && !/[0-9]/.test(w)).slice(0, 5);
  for (const ctx of contexts) {
    const { data: existing } = await supabase
      .from('topic_index')
      .select('weight')
      .eq('user_id', userId)
      .eq('topic', ctx)
      .maybeSingle();
    const newWeight = (existing?.weight || 0) + 0.1;
    await supabase.from('topic_index').upsert(
      {
        user_id: userId,
        topic: ctx,
        weight: newWeight,
        last_mentioned: new Date().toISOString(),
        related_terms: keyTerms,
      },
      { onConflict: 'user_id,topic' }
    );
  }
}

async function getRelatedTopics(userId: string, currentContext: string): Promise<string> {
  const { data: related } = await supabase
    .from('topic_index')
    .select('topic, weight')
    .eq('user_id', userId)
    .neq('topic', currentContext)
    .order('weight', { ascending: false })
    .limit(3);
  if (!related?.length) return '';
  return `\n[TÓPICOS RELACIONADOS]\n${related.map((t: any) => `- ${t.topic} (peso: ${Math.round((t.weight || 0) * 100)}%)`).join('\n')}`;
}

async function detectTopicShiftWithL4(userId: string, currentContexts: ContextType[]): Promise<boolean> {
  const { data: recentTopics } = await supabase
    .from('topic_index')
    .select('topic, weight')
    .eq('user_id', userId)
    .order('last_mentioned', { ascending: false })
    .limit(5);
  if (!recentTopics?.length) return false;
  const hasCurrentTopic = currentContexts.some((ctx) =>
    recentTopics.some((t: any) => t.topic === ctx && (t.weight || 0) >= 0.3)
  );
  return !hasCurrentTopic && !currentContexts.includes('casual');
}

const RAM_MAX_CHARS = 8000;

function compressToSummary(history: any[]): string {
  const topics = history
    .flatMap((h: any) => (h.metadata?.contexts_detected as string[] | undefined) || [])
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(', ');
  return topics ? `[Resumo do assunto anterior: ${topics}]` : '[Contexto anterior resumido]';
}

async function semanticRamCompression(
  history: any[],
  userId: string,
  messageText: string,
  currentEmbedding?: number[]
): Promise<string> {
  if (!history.length) return '';
  const embedding = currentEmbedding || (await getCachedEmbedding(messageText));
  const { data: relevantMemories } = (await supabase.rpc('match_memories', {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 5,
  })) as { data: any[] | null };
  if (relevantMemories && relevantMemories.length > 0) {
    const semanticBlock = relevantMemories
      .filter((r: any) => !r.summary.startsWith('[CINZA]'))
      .map((r: any) => r.summary)
      .join('\n---\n');
    return `[MEMÓRIAS SEMANTICAMENTE RELEVANTES]\n${semanticBlock}`;
  }
  return '';
}

function isMeaningfulDiaryBlock(block: string): boolean {
  if (!block) return false;
  const lower = block.toLowerCase();
  if (lower.includes('nenhum') || lower.includes('não encontrado') || lower.includes('sem registro')) return false;
  return true;
}

// ============================================================
// MAIN POST HANDLER
// ============================================================
export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || '';
    let messageText = '';
    let userEmail = '';
    let tempUserId = '';
    let clientSessionId: string | null = null;
    let userFirstName = 'Usuário';

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      userEmail = (formData.get('userEmail') as string) || (formData.get('email') as string) || '';
      tempUserId = (formData.get('userId') as string) || (formData.get('user_id') as string) || '';
      clientSessionId = formData.get('sessionId') as string | null;
      userFirstName = (formData.get('userFirstName') as string) || 'Usuário';
      messageText = (formData.get('message') as string) || ''; 
    } else {
      const body = await req.json();
      messageText = body.message || '';
      userEmail = body.userEmail || body.email || '';
      tempUserId = body.userId || body.user_id || '';
      clientSessionId = body.sessionId || null;
      userFirstName = body.userFirstName || 'Usuário';
    }

    let userRecord = null;

    if (userEmail) {
      const { data } = await supabase
        .from('users')
        .select('id, nickname, current_context, assistant_name, timezone, pending_question, pending_context')
        .eq('email', userEmail)
        .maybeSingle();
      userRecord = data;
    }

    if (!userRecord && tempUserId) {
      const { data } = await supabase
        .from('users')
        .select('id, nickname, current_context, assistant_name, timezone, pending_question, pending_context')
        .eq('id', tempUserId)
        .maybeSingle();
      userRecord = data;
    }

    if (!userRecord) {
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });
    }

    // ==========================================================
    // CRÍTICO: SEPARAÇÃO ESTRITA ENTRE BIGINT E UUID
    // ==========================================================
    const numericUserIdStr = userRecord.id.toString(); // BIGINT OBRIGATÓRIO (users.id)
    const sessionId = clientSessionId || (await getOrCreateSession(numericUserIdStr)); // UUID DA SESSÃO
    const currentEmbedding = await getCachedEmbedding(messageText);

    // Contexto
    console.time('[Performance] context_classification');
    const detectedContexts = await classifyContextWithL4(messageText, numericUserIdStr);
    console.timeEnd('[Performance] context_classification');
    const modelRoute = routeModel(detectedContexts);
    
    await updateTopicIndex(numericUserIdStr, detectedContexts, messageText);
    ensureMemoryHealth(numericUserIdStr);

    let searchBlock = '';
    // AQUI USAMOS A NOVA LÓGICA ASSÍNCRONA PARA BARRAR A AMNÉSIA
    const isForcedSearch = await shouldForceSearch(messageText, detectedContexts, numericUserIdStr, currentEmbedding);
    
    if (isForcedSearch) {
      const query = refineSearchQuery(messageText, detectedContexts);
      console.log(`[tool] searchWeb: "${query}"`);
      const searchRes = await searchWeb(query);
      if (searchRes) {
        searchBlock = `[BUSCA WEB RECENTE]\n${searchRes}\n`;
      }
    }

    // Preparando blocos de prompt...
    let ramBlock = '';
    const { data: historySession } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('user_id', numericUserIdStr) // BIGINT CORRETO
      .eq('session_id', sessionId)     // UUID CORRETO
      .neq('category', 'archived')
      .order('created_at', { ascending: false })
      .limit(10);

    const topicShifted = await detectTopicShiftWithL4(numericUserIdStr, detectedContexts);
    
    if (historySession && historySession.length > 0) {
      ramBlock = await semanticRamCompression(historySession, numericUserIdStr, messageText, currentEmbedding);
    }

    const systemPrompt = `[INTERNO]\nVocê é um assistente. Contextos: ${detectedContexts.join(', ')}.\n${searchBlock}\n${ramBlock}`;

    // Chamada à LLM (OpenRouter)
    const conversationMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: messageText }
    ];

    const finalResponse = await callOpenRouter(conversationMessages, modelRoute.model);

    // ==========================================================
    // CORREÇÃO CRÍTICA NAS TASKS DE BACKGROUND (Tabela Brain e Perfis)
    // ==========================================================
    const isLikelyNoise = false; 
    const backgroundTasks = [];

    if (!isLikelyNoise) {
      backgroundTasks.push(
        withRetry(() =>
          // AQUI ESTAVA CAUSANDO O ERRO 22P02 POR USAR sessionId.
          // AGORA USA numericUserIdStr ESTRITAMENTE
          extractAndSummarize(numericUserIdStr, messageText, finalResponse)
        ).catch((e) => console.error('[Extrator/perfil] Erro:', e))
      );

      backgroundTasks.push(
        withRetry(() =>
          extractRecomendacao(numericUserIdStr, messageText, finalResponse)
        ).catch((e) => console.error('[Extrator/recomendacao] Erro:', e))
      );

      backgroundTasks.push(
        withRetry(() =>
          extractDiary(numericUserIdStr, messageText, 'anytime')
        ).catch((e) => console.error('[diary] Erro:', e))
      );

      backgroundTasks.push(
        withRetry(() => extractGoal(numericUserIdStr, messageText)).catch((e) => console.error('[goals] Erro:', e))
      );
    }

    Promise.all([
      ...backgroundTasks,
      // INSERÇÃO CORRIGIDA NO BRAIN (Evita BRAIN INSERT ERRO)
      supabase
        .from('brain')
        .insert({
           user_id: numericUserIdStr, // Deve ser o BIGINT (ex: '1')
           session_id: sessionId,     // Deve ser o UUID ('cb2c152a...')
           content: messageText,
           role: 'user',
           category: 'info',
           embedding: currentEmbedding
        })
        .then(() => {
           // Checa limites e compacta
           return supabase
            .from('brain')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', numericUserIdStr)
            .eq('category', 'info')
            .then(({ count }) => {
              if (count && count >= 20) return compactMemory(numericUserIdStr, userRecord.nickname);
            });
        })
    ]).catch((e) => console.error('[Background] Erro:', e));

    console.timeEnd('[Performance] total');
    return NextResponse.json({ response: finalResponse, sessionId });

  } catch (err: any) {
    console.error('[ERRO FATAL]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw lastErr;
}