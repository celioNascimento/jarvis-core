// app/api/chat/route.ts
// Motor V8 completo — busca forçada, tools, memória, L4, ReAct loop
// Parse de entrada compatível com React Native (email + userId)

import { NextRequest, NextResponse } from 'next/server';
import {
  supabase,
  callOpenRouter,
  generateEmbedding,
  compactMemory,
  getOrCreateSession,
  reinforceMemory,
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

export const maxDuration = 25;

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
// Classificação de contexto — com esporte, noticias, clima
// ============================================================
type ContextType =
  | 'agenda' | 'projeto' | 'familia' | 'emocao' | 'diario' | 'meta'
  | 'saude' | 'recomendacao' | 'evento' | 'rotina' | 'preferencia'
  | 'alias' | 'email' | 'casual' | 'esporte' | 'noticias' | 'clima';

function classifyContextRegex(text: string): ContextType[] {
  // Normaliza sem acentos para comparação robusta
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const rules: Array<[RegExp, ContextType]> = [
    [/diario|hoje foi|hoje ta|hoje esta|acordei|dormi|dormir|meu dia|como foi meu|reflexao|refletindo|gratid/i, 'diario'],
    [/meta|objetivo|quero (conseguir|fazer|terminar|lancar|comecar)|prazo|progresso|etapa|concluir|finalizar/i, 'meta'],
    [/reuniao|consulta|compromisso|agend|horario|amanha as|segunda|terca|quarta|quinta|sexta|sabado|domingo|as \d|as \d{1,2}h/i, 'agenda'],
    [/projeto|app|aplicativo|sistema|api|deploy|feature|sprint|mvp|startup|produto|desenvolv/i, 'projeto'],
    [/filho|filha|esposa|marido|mae|pai|irmao|familia|conjuge|casamento|nasceu|aniversario de casamento/i, 'familia'],
    [/medic|saude|exame|remedio|hospital|dor |doenca|sintoma|consulta medica/i, 'saude'],
    [/sinto|estou (triste|feliz|ansioso|cansado|animado|frustrado|preocupado|deprimido|sozinho)|me sinto|to mal|to bem|angustia|estressado/i, 'emocao'],
    [/email|e-mail|inbox|caixa de entrada|mensagem do|mensagem da|enviou|recebeu/i, 'email'],
    [/indica|recomend|sugere|onde posso|tem algum|onde tem|restaurante|lugar bom|conhece algum/i, 'recomendacao'],
    [/aniversario|natal|pascoa|ano novo|feriado|data importante|comemora/i, 'evento'],
    [/acordo|desperto|academia|treino|trabalho as|entrada no trabalho|saida do trabalho|rotina|horario de/i, 'rotina'],
    [/gosto de|nao gosto de|prefiro|adoro|odeio|minha comida|meu filme|minha musica/i, 'preferencia'],
    [/quando falo em|quando eu falar|pode chamar de|se eu disser|apelido|alias/i, 'alias'],
    [/jogo|partida|futebol|basquete|volei|tenis|f1|corrida|campeonato|copa|libertadores|serie a|serie b|classificacao|tabela|artilheiro|resultado|placar|hoje tem jogo|proximo jogo|data do jogo|horario do jogo|escalacao/i, 'esporte'],
    [/noticia|noticias|ultimas|recente|aconteceu|hoje no|manchete|jornal|portal|g1|globo|folha|estadao/i, 'noticias'],
    [/clima|temperatura|chuva|frio|calor|previsao|amanhecer|umidade|vento|chover|chuvoso/i, 'clima'],
  ];
  const detected: ContextType[] = [];
  for (const [rx, ctx] of rules) {
    if (rx.test(t)) detected.push(ctx);
  }
  return detected.length > 0 ? detected : ['casual'];
}

async function classifyContextWithL4(text: string, userId: string): Promise<ContextType[]> {
  const regexContexts = classifyContextRegex(text);
  if (regexContexts.length > 2) {
    const { data: topicWeights } = await supabase
      .from('topic_index').select('topic, weight').eq('user_id', userId).in('topic', regexContexts);
    if (topicWeights?.length) {
      const sorted = topicWeights.sort((a, b) => (b.weight || 0) - (a.weight || 0));
      const prioritized = sorted.map(t => t.topic as ContextType);
      const missing = regexContexts.filter(c => !prioritized.includes(c));
      return [...prioritized, ...missing];
    }
  }
  return regexContexts;
}

// ============================================================
// Roteamento de modelo e temperatura
// ============================================================
function routeModel(contexts: ContextType[]): { model: string; label: string } {
  const complex: ContextType[] = ['agenda', 'projeto', 'familia', 'emocao', 'diario', 'meta', 'saude', 'esporte', 'noticias', 'clima'];
  return contexts.some(c => complex.includes(c))
    ? { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet' }
    : { model: 'google/gemini-2.0-flash-001', label: 'flash' };
}

function getTemperature(contexts: ContextType[]): number {
  if (contexts.some(c => ['emocao', 'diario'].includes(c))) return 0.9;
  if (contexts.some(c => ['casual', 'projeto', 'familia', 'meta', 'esporte'].includes(c))) return 0.7;
  if (contexts.some(c => ['rotina', 'alias', 'preferencia', 'recomendacao', 'noticias', 'clima'].includes(c))) return 0.5;
  if (contexts.some(c => ['agenda', 'evento', 'email', 'saude'].includes(c))) return 0.3;
  return 0.7;
}

function planContextualBlocks(contexts: ContextType[]) {
  return {
    loadTopics:          contexts.some(c => ['saude', 'projeto', 'familia', 'casual', 'rotina', 'preferencia', 'esporte', 'noticias', 'clima'].includes(c)),
    loadDiary:           contexts.some(c => ['diario', 'meta', 'emocao', 'casual'].includes(c)),
    loadRecommendations: contexts.some(c => ['recomendacao', 'casual'].includes(c)),
    loadCalendar:        contexts.some(c => ['agenda', 'evento', 'familia'].includes(c)),
    loadEmail:           contexts.some(c => ['email'].includes(c)),
  };
}

// ============================================================
// Busca forçada
// ============================================================
function shouldForceSearch(message: string, contexts: ContextType[]): boolean {
  const lower = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const keywords = /\b(jogo|partida|futebol|basquete|volei|tenis|f1|corrida|campeonato|copa|libertadores|classificacao|tabela|artilheiro|resultado|placar|hoje tem|quando e|proximo|escalacao|expo|feira|comeca|inicio|data de|horario de|edicao|noticia|ultimas|recente|aconteceu|clima|temperatura|chuva|chover|previsao|cotacao|preco do|valor do|dolar|euro|bitcoin|ibovespa)\b/i;
  if (keywords.test(lower)) {
    console.log('[shouldForceSearch] Palavra-chave detectada');
    return true;
  }
  if (/(quando|qual e|como esta|como fica|o que aconteceu|o que rolou|vai chover|vai ter|como vai ser)/i.test(lower)) {
    console.log('[shouldForceSearch] Palavra temporal detectada');
    return true;
  }
  console.log('[shouldForceSearch] Sem gatilho');
  return false;
}

function refineSearchQuery(message: string, contexts: ContextType[]): string {
  let query = message;
  if (contexts.includes('esporte')) {
    const teamMatch = message.match(/(?:do|da|de|contra|entre) (.*?)(?:\?|$)/i);
    if (teamMatch && teamMatch[1].trim().length < 30) {
      query = `${teamMatch[1].trim()} ${message.toLowerCase().includes('escala') ? 'escalação' : 'próximo jogo'} 2026`;
    } else {
      query = `${message} 2026`;
    }
  }
  if (contexts.includes('clima')) {
    const loc = message.match(/(em|no|na) (.*?)(?:\?|$)/i);
    query = loc ? `clima ${loc[2].trim()}` : `clima ${message}`;
  }
  if (contexts.includes('noticias') && !/notic/i.test(query)) {
    query = `últimas notícias ${query}`;
  }
  return query.trim();
}

// ============================================================
// Topic Index (L4)
// ============================================================
async function updateTopicIndex(userId: string, contexts: string[], messageText: string) {
  if (!contexts.length) return;
  const keyTerms = messageText.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !/[0-9]/.test(w)).slice(0, 5);
  for (const ctx of contexts) {
    const { data: existing } = await supabase.from('topic_index').select('weight').eq('user_id', userId).eq('topic', ctx).maybeSingle();
    await supabase.from('topic_index').upsert({
      user_id: userId, topic: ctx,
      weight: (existing?.weight || 0) + 0.1,
      last_mentioned: new Date().toISOString(),
      related_terms: keyTerms,
    }, { onConflict: 'user_id,topic' });
  }
}

async function getRelatedTopics(userId: string, currentContext: string): Promise<string> {
  const { data: related } = await supabase.from('topic_index').select('topic, weight')
    .eq('user_id', userId).neq('topic', currentContext)
    .order('weight', { ascending: false }).limit(3);
  if (!related?.length) return '';
  return `\n[TÓPICOS RELACIONADOS]\n${related.map((t: any) => `- ${t.topic} (peso: ${Math.round(t.weight * 100)}%)`).join('\n')}`;
}

async function detectTopicShift(userId: string, currentContexts: ContextType[]): Promise<boolean> {
  const { data: recentTopics } = await supabase.from('topic_index').select('topic, weight')
    .eq('user_id', userId).order('last_mentioned', { ascending: false }).limit(5);
  if (!recentTopics?.length) return false;
  const hasCurrentTopic = currentContexts.some(ctx =>
    recentTopics.some((t: any) => t.topic === ctx && (t.weight || 0) >= 0.3)
  );
  return !hasCurrentTopic && !currentContexts.includes('casual');
}

// ============================================================
// RAM
// ============================================================
const RAM_MAX_CHARS = 8000;

function compressToSummary(history: any[]): string {
  const topics = history
    .flatMap((h: any) => (h.metadata?.contexts_detected as string[] | undefined) || [])
    .filter((v, i, a) => a.indexOf(v) === i).join(', ');
  return topics ? `[Resumo do assunto anterior: ${topics}]` : '[Contexto anterior resumido]';
}

async function semanticRamCompression(history: any[], userId: string, currentEmbedding: number[]): Promise<string> {
  if (!history.length) return '';
  const { data: mems } = await supabase.rpc('match_memories', { query_embedding: currentEmbedding, match_threshold: 0.4, match_count: 5 }) as { data: any[] | null };
  if (mems?.length) {
    return `[MEMÓRIAS SEMANTICAMENTE RELEVANTES]\n${mems.filter((r: any) => !r.summary.startsWith('[CINZA]')).map((r: any) => r.summary).join('\n---\n')}`;
  }
  return '';
}

// ============================================================
// TOOLS
// ============================================================
const tools = [
  { type: 'function', function: { name: 'buscar_memoria_longa', description: 'Busca memórias de longo prazo relevantes para o contexto atual', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'consultar_agenda', description: 'Obtém eventos do Google Calendar e Outlook', parameters: { type: 'object', properties: { dias: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'listar_emails_recentes', description: 'Busca emails recentes', parameters: { type: 'object', properties: { filtro: { type: 'string' } } } } },
  { type: 'function', function: { name: 'salvar_evento', description: 'Registra um evento no banco de dados', parameters: { type: 'object', properties: { titulo: { type: 'string' }, data: { type: 'string' }, prioridade: { type: 'string', enum: ['alta', 'media', 'baixa'] }, recorrente: { type: 'boolean' }, tipo: { type: 'string', enum: ['permanent', 'recurring_annual', 'deadline', 'one_time'] } }, required: ['titulo', 'data', 'prioridade', 'recorrente', 'tipo'] } } },
  { type: 'function', function: { name: 'atualizar_meta', description: 'Atualiza o progresso de uma meta', parameters: { type: 'object', properties: { titulo_parcial: { type: 'string' }, progresso: { type: 'integer' }, etapa_concluida: { type: 'string' } }, required: ['titulo_parcial', 'progresso'] } } },
  { type: 'function', function: { name: 'registrar_no_diario', description: 'Adiciona uma entrada no diário', parameters: { type: 'object', properties: { texto: { type: 'string' }, categoria: { type: 'string', enum: ['reflexao', 'acontecimento', 'gratidao', 'qualquer'] } }, required: ['texto'] } } },
  { type: 'function', function: { name: 'searchWeb', description: 'Pesquisa na internet em tempo real. Use para jogos, notícias, clima, cotações e qualquer informação atual de 2026.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'getWeatherForecast', description: 'Obtém clima preciso para 5 dias. Padrão: Londrina (-23.27, -51.20).', parameters: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } }, required: ['lat', 'lng'] } } },
  { type: 'function', function: { name: 'salvar_lugar', description: 'Salva um lugar favorito com coordenadas', parameters: { type: 'object', properties: { nome: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' }, raio_metros: { type: 'integer' }, categoria: { type: 'string' } }, required: ['nome', 'lat', 'lng', 'raio_metros', 'categoria'] } } },
  { type: 'function', function: { name: 'remover_lugar', description: 'Remove um lugar favorito', parameters: { type: 'object', properties: { nome: { type: 'string' } }, required: ['nome'] } } },
  { type: 'function', function: { name: 'adicionar_item_lista', description: 'Adiciona item à lista de compras de um lugar', parameters: { type: 'object', properties: { item: { type: 'string' }, lugar: { type: 'string' } }, required: ['item', 'lugar'] } } },
  { type: 'function', function: { name: 'marcar_feito', description: 'Marca item da lista como comprado', parameters: { type: 'object', properties: { item: { type: 'string' }, lugar: { type: 'string' } }, required: ['item', 'lugar'] } } },
  { type: 'function', function: { name: 'remover_item_lista', description: 'Remove item da lista de compras', parameters: { type: 'object', properties: { item: { type: 'string' }, lugar: { type: 'string' } }, required: ['item', 'lugar'] } } },
  { type: 'function', function: { name: 'ver_lista', description: 'Exibe lista de compras de um lugar', parameters: { type: 'object', properties: { lugar: { type: 'string' } }, required: ['lugar'] } } },
];

// ============================================================
// Executor de ferramentas
// ============================================================
async function executeTool(toolCall: any, userId: string): Promise<string> {
  const { name, arguments: args } = toolCall.function;
  let p: any;
  try { p = JSON.parse(args); } catch { return `Erro ao parsear argumentos de ${name}.`; }

  async function getPlaceId(nome: string): Promise<string | null> {
    const { data } = await supabase.from('favorite_places').select('id').eq('user_id', userId).ilike('name', nome.trim()).single();
    return data?.id ?? null;
  }

  switch (name) {
    case 'buscar_memoria_longa': {
      const emb = await getCachedEmbedding(p.query);
      const { data: mems } = await supabase.rpc('match_memories', { query_embedding: emb, match_threshold: 0.4, match_count: 5 });
      return mems?.filter((m: any) => !m.summary.startsWith('[CINZA]')).map((m: any) => m.summary).join('\n---\n') || 'Nenhuma memória relevante.';
    }
    case 'consultar_agenda': {
      const [g, o] = await Promise.all([getGoogleContext(), getMicrosoftCalendarContext()]);
      return `Google Calendar:\n${g}\n\nOutlook:\n${o}`;
    }
    case 'listar_emails_recentes':
      return await getRecentEmails(p.filtro, 5, true);
    case 'salvar_evento': {
      const cat = p.titulo.toLowerCase().includes('aniversario') ? 'family' : 'personal';
      await upsertEvent(userId, { title: p.titulo, event_date: p.data, priority: p.prioridade, is_recurring: p.recorrente, decay_type: p.tipo, category: cat, emotional_weight: p.prioridade === 'alta' ? 0.9 : p.prioridade === 'media' ? 0.6 : 0.3 });
      return `Evento "${p.titulo}" salvo.`;
    }
    case 'atualizar_meta':
      return await updateGoalProgress(userId, p.titulo_parcial, p.progresso, p.etapa_concluida);
    case 'registrar_no_diario':
      await extractDiary(userId, p.texto, p.categoria || 'anytime');
      return 'Entrada registrada no diário.';
    case 'pesquisar_internet':
    case 'searchWeb': {
      console.log(`[tool] searchWeb: "${p.query}"`);
      const result = await searchWeb(p.query);
      console.log(`[tool] resultado (200): ${result.substring(0, 200)}`);
      return result;
    }
    case 'getWeatherForecast':
      return await getWeatherForecast(p.lat, p.lng);
    case 'salvar_lugar': {
      const { error } = await supabase.from('favorite_places').upsert({ user_id: userId, name: p.nome.trim(), lat: p.lat, lng: p.lng, radius_meters: p.raio_metros, category: p.categoria.trim() }, { onConflict: 'user_id,name' });
      return error ? `Erro: ${error.message}` : `Lugar "${p.nome}" salvo.`;
    }
    case 'remover_lugar':
      await supabase.from('favorite_places').delete().eq('user_id', userId).ilike('name', p.nome.trim());
      return `Lugar "${p.nome}" removido.`;
    case 'adicionar_item_lista': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
      await supabase.from('shopping_items').upsert({ user_id: userId, item: p.item.trim(), place_id: pid, done: false }, { onConflict: 'user_id,item,place_id' });
      return `"${p.item}" adicionado à lista de ${p.lugar}.`;
    }
    case 'marcar_feito': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
      await supabase.from('shopping_items').update({ done: true }).eq('user_id', userId).ilike('item', p.item.trim()).eq('place_id', pid);
      return `"${p.item}" marcado como comprado.`;
    }
    case 'remover_item_lista': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
      await supabase.from('shopping_items').delete().eq('user_id', userId).ilike('item', p.item.trim()).eq('place_id', pid);
      return `"${p.item}" removido.`;
    }
    case 'ver_lista': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
      const { data: itens } = await supabase.from('shopping_items').select('item, done').eq('user_id', userId).eq('place_id', pid).order('done');
      if (!itens?.length) return `Lista de ${p.lugar} está vazia.`;
      return `Lista de ${p.lugar}:\n${itens.map((i: any) => `${i.done ? '✅' : '•'} ${i.item}`).join('\n')}`;
    }
    default:
      return `Ferramenta ${name} não implementada.`;
  }
}

// ============================================================
// callOpenRouterWithTools
// ============================================================
interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; }
interface ToolResponse { content: string; toolCalls: ToolCall[] | null; }

async function callOpenRouterWithTools(messages: any[], toolsDef: any[], model: string, temperature: number, timeoutMs = 22000): Promise<ToolResponse> {
  const response = await Promise.race([
    fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Lev',
      },
      body: JSON.stringify({ model, messages, tools: toolsDef, tool_choice: 'auto', temperature, max_tokens: 2000 }),
    }),
    new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs)),
  ]);
  if (!response.ok) throw new Error(`OpenRouter error: ${response.status}`);
  const data = await response.json();
  const choice = data.choices?.[0];
  return { content: choice?.message?.content || '', toolCalls: choice?.message?.tool_calls || null };
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T | null> {
  for (let i = 0; i <= maxRetries; i++) {
    try { return await fn(); } catch (e) {
      if (i < maxRetries) await new Promise(r => setTimeout(r, 1000));
      else console.error('Falha após retries:', e);
    }
  }
  return null;
}

// ============================================================
// POST — Handler principal
// ============================================================
export async function POST(req: NextRequest) {
  console.log('[chat] 1. parse body');
  try {
    // ----------------------------------------------------------
    // Parse — JSON do app React Native
    // ----------------------------------------------------------
    const body = await req.json();
    const messageText: string = body.message || body.text || '';
    const userEmail: string   = body.userEmail || body.email || '';
    const clientSessionId     = body.sessionId || null;

    console.log('[chat] 2. message:', messageText?.slice(0, 30), '| email:', userEmail);

    if (!messageText) return NextResponse.json({ error: 'message obrigatório' }, { status: 400 });

    // ----------------------------------------------------------
    // Resolve userId via email ou direto
    // ----------------------------------------------------------
    console.log('[chat] 3. buscando usuário:', userEmail);
    let userId = body.userId || body.user_id || '';

    if (!userId && userEmail) {
      const { data: userByEmail } = await supabase.from('users').select('id').eq('email', userEmail).maybeSingle();
      userId = userByEmail?.id || '';
    }
    if (!userId && userEmail) {
      const { data: authData } = await supabase.auth.admin.getUserById(userEmail).catch(() => ({ data: null }));
      userId = (authData as any)?.user?.id || '';
    }
    if (!userId) return NextResponse.json({ error: 'Não foi possível identificar o usuário' }, { status: 400 });

    userId = String(userId);

    const { data: userProfile } = await supabase.from('users')
      .select('nickname, current_context, assistant_name, timezone')
      .eq('id', userId).single();

    console.log('[chat] 4. userProfile:', userId, '| erro: undefined');

    const authorName       = userProfile?.nickname        || 'você';
    const assistantName    = userProfile?.assistant_name  || 'Lev';
    const userTimezone     = userProfile?.timezone        || 'America/Sao_Paulo';
    const currentContextL3 = userProfile?.current_context || '';

    // ----------------------------------------------------------
    // Sessão
    // ----------------------------------------------------------
    const sessionId = clientSessionId || (await getOrCreateSession(userId));
    console.log('[chat] 5. sessionId:', sessionId);

    // ----------------------------------------------------------
    // Classificação de contexto
    // ----------------------------------------------------------
    const detectedContexts = await classifyContextWithL4(messageText, userId);
    const modelRoute  = routeModel(detectedContexts);
    const temperature = getTemperature(detectedContexts);
    const blockPlan   = planContextualBlocks(detectedContexts);
    console.log('[chat] 6. contexts:', detectedContexts, '| model:', modelRoute.label);

    await updateTopicIndex(userId, detectedContexts, messageText);
    const relatedTopicsBlock = await getRelatedTopics(userId, detectedContexts[0] || 'casual');

    // ----------------------------------------------------------
    // Pesquisa forçada — ANTES de tudo
    // ----------------------------------------------------------
    let forcedSearchResult = '';
    if (shouldForceSearch(messageText, detectedContexts)) {
      const searchQuery = refineSearchQuery(messageText, detectedContexts);
      console.log('[chat] ForcedSearch:', searchQuery);
      try {
        const result = await searchWeb(searchQuery);
        forcedSearchResult = `\n[PESQUISA AUTOMÁTICA REALIZADA]\nConsulta: "${searchQuery}"\nResultado:\n${result}`;
        console.log('[chat] ForcedSearch ok (200):', result.substring(0, 200));
      } catch (e) {
        console.error('[chat] ForcedSearch falhou:', e);
        forcedSearchResult = '\n[ERRO NA PESQUISA] Não foi possível obter informações atualizadas.';
      }
    }

    // ----------------------------------------------------------
    // Cargas contextuais paralelas
    // ----------------------------------------------------------
    const conditionalTasks: Promise<any>[] = [];
    if (blockPlan.loadCalendar) {
      conditionalTasks.push(getGoogleContext().catch(() => null));
      conditionalTasks.push(getMicrosoftCalendarContext().catch(() => null));
    }
    if (blockPlan.loadEmail)  conditionalTasks.push(getRecentEmails(undefined, 3, false).catch(() => null));
    if (blockPlan.loadTopics) conditionalTasks.push(buildTopicBlock(userId, messageText).catch(() => ''));
    if (blockPlan.loadDiary)  conditionalTasks.push(buildDiaryGoalsBlock(userId).catch(() => ''));

    const [gapsBlock, recsBlock, conditionalResults] = await Promise.all([
      buildGapsBlock(userId, messageText).catch(() => ''),
      blockPlan.loadRecommendations ? buildRecommendationsBlock(userId, messageText).catch(() => '') : Promise.resolve(''),
      Promise.all(conditionalTasks),
    ]);

    let ri = 0;
    const googleCtx  = blockPlan.loadCalendar ? conditionalResults[ri++] : null;
    const msCtx      = blockPlan.loadCalendar ? conditionalResults[ri++] : null;
    const emailBlock = blockPlan.loadEmail    ? conditionalResults[ri++] : null;
    const topicBlock = blockPlan.loadTopics   ? (conditionalResults[ri++] || '') : '';
    const diaryBlock = blockPlan.loadDiary    ? (conditionalResults[ri++] || '') : '';

    // ----------------------------------------------------------
    // RAM + HD vetorial
    // ----------------------------------------------------------
    const queryEmbedding = await getCachedEmbedding(messageText);
    let hdBlock = '';
    let hdIds: string[] = [];
    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', { query_embedding: queryEmbedding, match_threshold: 0.4, match_count: 3 }) as { data: any[] | null };
      if (search?.length) {
        hdBlock = search.filter((r: any) => !r.summary.startsWith('[CINZA]')).map((r: any) => r.summary).join('\n---\n');
        hdIds   = search.map((r: any) => r.id);
      }
    }

    const { data: historySession } = await supabase.from('brain').select('content, metadata')
      .eq('user_id', userId).eq('session_id', sessionId)
      .neq('category', 'archived').order('created_at', { ascending: false }).limit(10);

    const topicShifted = await detectTopicShift(userId, detectedContexts);
    let ramBlock = '';
    if (historySession && historySession.length >= 2) {
      if (topicShifted) {
        const summary   = compressToSummary(historySession.slice(3));
        const recentRaw = [...historySession].slice(0, 3).reverse()
          .map((h: any) => `${authorName}: ${h.content}\n${assistantName}: ${(h.metadata?.ai_reply || '').replace(/\[.*?\]/g, '').trim()}`).join('\n\n');
        ramBlock = `${summary}\n\n${recentRaw}`;
      } else {
        ramBlock = [...historySession].reverse()
          .map((h: any) => `${authorName}: ${h.content}\n${assistantName}: ${(h.metadata?.ai_reply || '').replace(/\[.*?\]/g, '').trim()}`).join('\n\n');
      }
    } else {
      const semBlock = await semanticRamCompression(historySession || [], userId, queryEmbedding);
      ramBlock = semBlock || (hdBlock ? `[Contexto anterior]\n${hdBlock}` : '');
    }
    if (ramBlock.length > RAM_MAX_CHARS) ramBlock = ramBlock.slice(-RAM_MAX_CHARS);

    const fusoHorario = new Date().toLocaleString('pt-BR', { timeZone: userTimezone });

    // ----------------------------------------------------------
    // System prompt
    // ----------------------------------------------------------
    const systemPrompt = `Você é ${assistantName}, assistente pessoal de ${authorName}.
Data/hora: ${fusoHorario}

🚨 REGRA ABSOLUTA: Para jogos, notícias, clima, cotações, escalações ou qualquer informação que possa ter mudado — use a ferramenta searchWeb ANTES de responder. Nunca invente dados atuais.

${forcedSearchResult ? `${forcedSearchResult}\n\nSe o bloco acima contém dados, use-os como fonte principal.` : ''}

${googleCtx  ? `[AGENDA GOOGLE]\n${googleCtx}`   : ''}
${msCtx      ? `[AGENDA OUTLOOK]\n${msCtx}`      : ''}
${emailBlock ? `[EMAILS RECENTES]\n${emailBlock}` : ''}
${relatedTopicsBlock}
${currentContextL3 ? `[QUEM É ${authorName.toUpperCase()}]\n${currentContextL3}` : ''}
${recsBlock  ? recsBlock   : ''}
${topicBlock ? topicBlock  : ''}
${diaryBlock ? diaryBlock  : ''}
${hdBlock    ? `[MEMÓRIAS]\n${hdBlock}` : ''}
${ramBlock   ? `[CONVERSA RECENTE]\n${ramBlock}` : ''}
${gapsBlock  ? gapsBlock   : ''}

REGRAS COMPORTAMENTAIS:
1. Responda O QUE FOI PERGUNTADO. Pronomes se referem ao último assunto. Nunca repita sugestão rejeitada.
2. Tom: amigo inteligente, direto, humano. Nunca comece com "Considerando que" ou "Com base no seu perfil".
3. PROIBIDO: "Anotado!", "Registrado!", "Guardei aqui!". Se salvou algo via ferramenta, diga naturalmente: "Feito." ou "Tá na agenda."
4. Presença emocional: quando ${authorName} compartilhar algo difícil, seja empático — não aja como sistema de registros.
5. Use memórias naturalmente. Nunca diga "Tenho uma nota aqui que diz...".
6. Ao final da sua resposta: [CLASSE: info] ou [CLASSE: noise].`.trim();

    // ----------------------------------------------------------
    // Montagem das mensagens com histórico
    // ----------------------------------------------------------
    const { data: historyForMessages } = await supabase.from('brain').select('content, metadata')
      .eq('user_id', userId).neq('category', 'archived')
      .order('created_at', { ascending: false }).limit(8);

    const conversationMessages: any[] = [
      { role: 'system', content: systemPrompt },
      ...(historyForMessages || []).reverse().flatMap((h: any) => [
        { role: 'user',      content: h.content },
        { role: 'assistant', content: (h.metadata?.ai_reply || '').replace(/\[.*?\]/g, '').trim() },
      ]),
      { role: 'user', content: messageText },
    ];

    // ----------------------------------------------------------
    // Comandos especiais
    // ----------------------------------------------------------
    if (/ignore isso|ignora isso|não salva|nao salva|apaga isso|esquece isso|delete isso/i.test(messageText)) {
      const { data: lastEntry } = await supabase.from('brain').select('id').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).single();
      if (lastEntry) await supabase.from('brain').delete().eq('id', lastEntry.id);
      return NextResponse.json({ reply: 'Feito — apaguei o que foi dito antes. 🗑️', sessionId });
    }

    // ----------------------------------------------------------
    // ReAct loop com ferramentas
    // ----------------------------------------------------------
    console.log('[chat] 7. chamando OpenRouter');
    let finalResponse = '';
    let attempts = 0;

    while (attempts < 5) {
      const response = await callOpenRouterWithTools(conversationMessages, tools, modelRoute.model, temperature);
      const { content, toolCalls } = response;

      if (!toolCalls || toolCalls.length === 0) {
        finalResponse = content;
        break;
      }

      conversationMessages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
      for (const toolCall of toolCalls) {
        const result = await executeTool(toolCall, userId);
        conversationMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      }
      attempts++;
    }

    if (!finalResponse) finalResponse = 'Ops, não consegui processar. Pode repetir?';
    console.log('[chat] 8. resposta length:', finalResponse.length);

    // ----------------------------------------------------------
    // Pós-processamento
    // ----------------------------------------------------------
    const categoryMatch = finalResponse.match(/\[CLASSE:\s*(\w+)\]/i);
    const category      = categoryMatch?.[1]?.toLowerCase() || 'info';
    let cleanReply      = finalResponse.replace(/\[CLASSE:\s*\w+\]/gi, '').trim();

    // Compatibilidade: gatilho legado de eventos via texto
    const eventRegex = /\[SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\s*\|\s*(recurring_annual|deadline|one_time)\]/gi;
    for (const m of Array.from(cleanReply.matchAll(eventRegex)) as any[]) {
      await upsertEvent(userId, { title: m[1].trim(), event_date: m[2], priority: m[3], is_recurring: m[4] === 'true', decay_type: m[5], category: 'personal', emotional_weight: m[3] === 'alta' ? 0.9 : 0.5 }).catch(() => {});
      cleanReply = cleanReply.replace(m[0], '').trim();
    }

    const goalMatch = cleanReply.match(/\[ATUALIZAR_META:\s*([^|]+)\|\s*(\d+)(?:\|\s*([^\]]+))?\]/i);
    if (goalMatch) {
      await updateGoalProgress(userId, goalMatch[1].trim(), parseInt(goalMatch[2]), goalMatch[3]?.trim()).catch(() => {});
      cleanReply = cleanReply.replace(goalMatch[0], '').trim();
    }

    console.log('[chat] 9. enviando resposta');

    // ----------------------------------------------------------
    // Background: persistência + extratores (não bloqueia resposta)
    // ----------------------------------------------------------
    Promise.all([
      supabase.from('brain').insert([{
        content: messageText, category, user_id: userId, session_id: sessionId,
        embedding: queryEmbedding,
        metadata: {
          ai_reply: cleanReply, user: authorName,
          model_used: modelRoute.model, model_label: modelRoute.label,
          temperature_used: temperature, contexts_detected: detectedContexts,
          forced_search_used: !!forcedSearchResult,
        },
      }]),
      ...hdIds.map(id => reinforceMemory(id)),
      withRetry(() => extractRecomendacao(userId, messageText, cleanReply)),
      withRetry(() => extractDiary(userId, messageText, 'anytime')),
      withRetry(() => extractGoal(userId, messageText)),
      supabase.from('brain').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('category', 'info')
        .then(({ count }) => { if (count && count >= 20) return compactMemory(userId, authorName); }),
    ]).catch(e => console.error('[chat/background] Erro:', e));

    return NextResponse.json({ reply: cleanReply, sessionId });

  } catch (error: any) {
    console.error('[chat] ERRO:', error.message);
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}