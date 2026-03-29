// app/api/chat/route.ts
// Motor V8 Unificado — Arquitetura Dual-ID: Separação cirúrgica entre Auth UUID (brain, lugares) e Numeric ID (events, goals)
// CORREÇÕES APLICADAS:
//   1. users lookup aceita userId OU email (fallback robusto, não quebra clientes antigos)
//   2. pending_question restaurado (campo consultado direto da tabela users)
//   3. API key corrigida: OPENROUTER_API_KEY para chamadas ao OpenRouter
//   4. Imports restaurados: setPendingQuestion, clearPendingQuestion, getPendingQuestion

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
    'agenda',
    'projeto',
    'familia',
    'emocao',
    'diario',
    'meta',
    'saude',
    'esporte',
    'noticias',
    'clima',
  ];
  return contexts.some((c) => complex.includes(c))
    ? { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet' }
    : { model: 'google/gemini-2.0-flash-001', label: 'flash' };
}

function getTemperature(contexts: ContextType[]): number {
  if (contexts.some((c) => ['emocao', 'diario'].includes(c))) return 0.9;
  if (
    contexts.some((c) =>
      ['casual', 'projeto', 'familia', 'meta', 'esporte'].includes(c)
    )
  )
    return 0.7;
  if (
    contexts.some((c) =>
      [
        'rotina',
        'alias',
        'preferencia',
        'recomendacao',
        'noticias',
        'clima',
      ].includes(c)
    )
  )
    return 0.5;
  if (
    contexts.some((c) => ['agenda', 'evento', 'email', 'saude'].includes(c))
  )
    return 0.3;
  return 0.7;
}

function planContextualBlocks(contexts: ContextType[]) {
  return {
    loadTopics: contexts.some((c) =>
      [
        'saude',
        'projeto',
        'familia',
        'casual',
        'rotina',
        'preferencia',
        'esporte',
        'noticias',
        'clima',
      ].includes(c)
    ),
    loadDiary: contexts.some((c) =>
      ['diario', 'meta', 'emocao', 'casual'].includes(c)
    ),
    loadRecommendations: contexts.some((c) =>
      ['recomendacao', 'casual'].includes(c)
    ),
    loadCalendar: contexts.some((c) =>
      ['agenda', 'evento', 'familia'].includes(c)
    ),
    loadEmail: contexts.some((c) => ['email'].includes(c)),
  };
}

// ============================================================
// Busca forçada (com normalização de acentos)
// ============================================================
function shouldForceSearch(
  message: string,
  contexts: ContextType[]
): boolean {
  const lower = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  // REGRA 1 (ALTA PRIORIDADE): Se a frase é sobre o próprio usuário,
  // o banco de dados tem a resposta — nunca buscar na web.
  // Inclui pronomes de 1ª pessoa E verbos conjugados na 1ª pessoa.
  const personalKeywords =
    /\b(eu|meu|minha|meus|minhas|comecei|trabalhei|trabalho|nasci|moro|morei|casei|tive|tenho|familia|esposa|marido|filho|filha|minha vida|meu trabalho|minha historia|quando comecei|quando fui|quando entrei)\b/i;
  if (personalKeywords.test(lower)) {
    console.log(
      '[shouldForceSearch] Frase pessoal detectada — usando banco de dados, sem busca web.'
    );
    return false;
  }

  // REGRA 2: Palavras-chave de domínio externo (esporte, mercado, notícias, clima)
  const keywords =
    /\b(jogo|partida|futebol|basquete|volei|tenis|f1|corrida|campeonato|copa|libertadores|copa do brasil|classificacao|tabela|artilheiro|resultado|placar|hoje tem|proximo|escalacao|expo|feira|comeca|inicio|data de|horario de|edicao|noticia|ultimas|recente|aconteceu|clima|temperatura|chuva|chover|previsao|cotacao|preco do|valor do|dolar|euro|bitcoin|ibovespa)\b/i;
  if (keywords.test(lower)) {
    console.log('[shouldForceSearch] Palavra-chave externa detectada, forçando busca');
    return true;
  }

  // REGRA 3: Palavras temporais — SÓ disparam se não houver contexto pessoal
  // "quando" sozinho não é suficiente se não houver objeto externo claro
  if (
    /(qual e|como esta|como fica|o que aconteceu|o que rolou|vai chover|vai ter|como vai ser)/i.test(
      lower
    )
  ) {
    console.log(
      '[shouldForceSearch] Palavra temporal de domínio externo detectada, forçando busca'
    );
    return true;
  }

  console.log('[shouldForceSearch] Nenhum gatilho externo detectado');
  return false;
}

function refineSearchQuery(
  message: string,
  contexts: ContextType[]
): string {
  let query = message.trim();

  if (contexts.includes('esporte')) {
    const cleanMsg = message
      .replace(
        /^(quando é|quando e|qual o|qual e|quem joga|onde e|onde vai ser)\s+/i,
        ''
      )
      .trim();
    query = `${cleanMsg} 2026`.replace(/\?+/g, '');
    if (
      !query.toLowerCase().includes('jogo') &&
      !query.toLowerCase().includes('escalação')
    ) {
      if (
        !query.toLowerCase().includes('próximo') &&
        !query.toLowerCase().includes('data') &&
        !query.toLowerCase().includes('horário')
      ) {
        query = `próximo jogo ${query}`;
      }
    }
  } else if (
    contexts.includes('evento') &&
    /expo|feira|evento|começa|início/i.test(message)
  ) {
    const currentYear = new Date().getFullYear();
    query = `${message} ${currentYear}`.replace(/\?+/g, '');
  } else if (contexts.includes('clima')) {
    const locationMatch = message.match(/(em|no|na) (.*?)(?:\?|$)/i);
    if (locationMatch && locationMatch[2].trim().length < 30) {
      query = `clima ${locationMatch[2].trim()}`;
    } else {
      query = `clima ${message}`.replace(/\?+/g, '');
    }
  } else if (
    contexts.includes('noticias') &&
    !/(notícia|notícias)/i.test(query)
  ) {
    query = `últimas notícias ${query}`;
  }

  return query.trim();
}

// ============================================================
// Topic Index (L4)
// ============================================================
async function updateTopicIndex(
  userId: string,
  contexts: string[],
  messageText: string
) {
  if (!contexts.length) return;
  const words = messageText.toLowerCase().split(/\s+/);
  const keyTerms = words
    .filter((w) => w.length > 3 && !/[0-9]/.test(w))
    .slice(0, 5);
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

async function getRelatedTopics(
  userId: string,
  currentContext: string
): Promise<string> {
  const { data: related } = await supabase
    .from('topic_index')
    .select('topic, weight')
    .eq('user_id', userId)
    .neq('topic', currentContext)
    .order('weight', { ascending: false })
    .limit(3);
  if (!related?.length) return '';
  return `\n[TÓPICOS RELACIONADOS]\n${related
    .map(
      (t: any) =>
        `- ${t.topic} (peso: ${Math.round((t.weight || 0) * 100)}%)`
    )
    .join('\n')}`;
}

async function detectTopicShiftWithL4(
  userId: string,
  currentContexts: ContextType[]
): Promise<boolean> {
  const { data: recentTopics } = await supabase
    .from('topic_index')
    .select('topic, weight')
    .eq('user_id', userId)
    .order('last_mentioned', { ascending: false })
    .limit(5);
  if (!recentTopics?.length) return false;
  const hasCurrentTopic = currentContexts.some((ctx) =>
    recentTopics.some(
      (t: any) => t.topic === ctx && (t.weight || 0) >= 0.3
    )
  );
  return !hasCurrentTopic && !currentContexts.includes('casual');
}

// ============================================================
// RAM
// ============================================================
const RAM_MAX_CHARS = 8000;

function compressToSummary(history: any[]): string {
  const topics = history
    .flatMap(
      (h: any) =>
        (h.metadata?.contexts_detected as string[] | undefined) || []
    )
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(', ');
  return topics
    ? `[Resumo do assunto anterior: ${topics}]`
    : '[Contexto anterior resumido]';
}

async function semanticRamCompression(
  history: any[],
  userId: string,
  messageText: string,
  currentEmbedding?: number[]
): Promise<string> {
  if (!history.length) return '';
  const embedding =
    currentEmbedding || (await getCachedEmbedding(messageText));
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
  if (
    lower.includes('nenhum') ||
    lower.includes('não encontrado') ||
    lower.includes('sem registro')
  )
    return false;
  return true;
}

// ============================================================
// Onboarding Persistente
// ============================================================
async function getOrCreateOnboardingStatePersistent(userId: string) {
  const { data: onboardingMemory } = await supabase
    .from('memories')
    .select('metadata')
    .eq('user_id', userId)
    .eq('category', 'onboarding')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (onboardingMemory?.metadata?.state) {
    return onboardingMemory.metadata.state;
  }
  return await initOnboarding(userId);
}

// ============================================================
// TOOLS
// ============================================================
const tools = [
  {
    type: 'function',
    function: {
      name: 'buscar_memoria_longa',
      description:
        'Busca memórias de longo prazo (L3 e HD) relevantes para o contexto atual',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Termo ou pergunta para busca semântica',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_agenda',
      description:
        'Obtém eventos do Google Calendar e Outlook para os próximos dias',
      parameters: {
        type: 'object',
        properties: {
          dias: {
            type: 'integer',
            description: 'Número de dias para frente (padrão 7)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_emails_recentes',
      description: 'Busca emails recentes, opcionalmente por filtro',
      parameters: {
        type: 'object',
        properties: {
          filtro: {
            type: 'string',
            description: 'Termo para filtrar emails (opcional)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'salvar_evento',
      description:
        'Registra um evento (compromisso, aniversário, etc.) no banco de dados',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string' },
          data: {
            type: 'string',
            format: 'date',
            description: 'YYYY-MM-DD',
          },
          prioridade: {
            type: 'string',
            enum: ['alta', 'media', 'baixa'],
          },
          recorrente: {
            type: 'boolean',
            description: 'true para aniversários e eventos anuais',
          },
          tipo: {
            type: 'string',
            enum: ['permanent', 'recurring_annual', 'deadline', 'one_time'],
          },
        },
        required: ['titulo', 'data', 'prioridade', 'recorrente', 'tipo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'atualizar_meta',
      description: 'Atualiza o progresso de uma meta existente',
      parameters: {
        type: 'object',
        properties: {
          titulo_parcial: {
            type: 'string',
            description: 'Parte do título da meta',
          },
          progresso: { type: 'integer', minimum: 0, maximum: 100 },
          etapa_concluida: {
            type: 'string',
            description: 'Nome da etapa concluída (opcional)',
          },
        },
        required: ['titulo_parcial', 'progresso'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registrar_no_diario',
      description: 'Adiciona uma entrada no diário pessoal',
      parameters: {
        type: 'object',
        properties: {
          texto: { type: 'string' },
          categoria: {
            type: 'string',
            enum: ['reflexao', 'acontecimento', 'gratidao', 'qualquer'],
          },
        },
        required: ['texto'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchWeb',
      description:
        'Pesquisa na internet em tempo real. Use para notícias, resultados de jogos, fatos de 2026 e informações que não estão na sua memória.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'O termo de busca preciso',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getWeatherForecast',
      description:
        'Obtém clima preciso para 5 dias. Use coordenadas de Londrina (-23.27, -51.20) para o Vista Bela se o usuário não der outras.',
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number' },
          lng: { type: 'number' },
        },
        required: ['lat', 'lng'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'salvar_lugar',
      description:
        'Salva um lugar favorito (mercado, farmácia, etc.) com coordenadas e raio de alerta',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome do lugar' },
          lat: { type: 'number', description: 'Latitude' },
          lng: { type: 'number', description: 'Longitude' },
          raio_metros: {
            type: 'integer',
            description: 'Raio em metros para alertas de proximidade',
          },
          categoria: {
            type: 'string',
            description: 'Categoria (ex: mercado, farmácia, restaurante)',
          },
        },
        required: ['nome', 'lat', 'lng', 'raio_metros', 'categoria'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remover_lugar',
      description: 'Remove um lugar favorito pelo nome',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome do lugar a remover' },
        },
        required: ['nome'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adicionar_item_lista',
      description:
        'Adiciona um item à lista de compras de um lugar específico',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'Nome do item' },
          lugar: {
            type: 'string',
            description: 'Nome do lugar (deve existir)',
          },
        },
        required: ['item', 'lugar'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'marcar_feito',
      description: 'Marca um item da lista como comprado',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'Nome do item' },
          lugar: { type: 'string', description: 'Nome do lugar' },
        },
        required: ['item', 'lugar'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remover_item_lista',
      description: 'Remove um item da lista de compras',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'Nome do item' },
          lugar: { type: 'string', description: 'Nome do lugar' },
        },
        required: ['item', 'lugar'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_lista',
      description: 'Exibe a lista de compras de um lugar',
      parameters: {
        type: 'object',
        properties: {
          lugar: { type: 'string', description: 'Nome do lugar' },
        },
        required: ['lugar'],
      },
    },
  },
];

// ============================================================
// Executor de ferramentas — Dual-ID por tabela
// ============================================================
async function executeTool(
  toolCall: any,
  authUserId: string,
  numericUserIdStr: string
): Promise<string> {
  const { name, arguments: args } = toolCall.function;
  let p: any;
  try {
    p = JSON.parse(args);
  } catch {
    return `Erro ao parsear argumentos de ${name}.`;
  }

  // Lugares e listas usam authUserId (schema: text/uuid)
  async function getPlaceId(nome: string): Promise<string | null> {
    const { data } = await supabase
      .from('favorite_places')
      .select('id')
      .eq('user_id', authUserId)
      .ilike('name', nome.trim())
      .single();
    return data?.id ?? null;
  }

  switch (name) {
    case 'buscar_memoria_longa': {
      const emb = await getCachedEmbedding(p.query);
      const { data: mems } = await supabase.rpc('match_memories', {
        query_embedding: emb,
        match_threshold: 0.4,
        match_count: 5,
      });
      return (
        mems
          ?.filter((m: any) => !m.summary.startsWith('[CINZA]'))
          .map((m: any) => m.summary)
          .join('\n---\n') || 'Nenhuma memória relevante.'
      );
    }

    case 'consultar_agenda': {
      const [g, o] = await Promise.all([
        getGoogleContext(),
        getMicrosoftCalendarContext(),
      ]);
      return `Google Calendar:\n${g}\n\nOutlook:\n${o}`;
    }

    case 'listar_emails_recentes':
      return await getRecentEmails(p.filtro, 5, true);

    case 'salvar_evento': {
      const cat = p.titulo.toLowerCase().includes('aniversario')
        ? 'family'
        : 'personal';
      await upsertEvent(numericUserIdStr, {
        title: p.titulo,
        event_date: p.data,
        priority: p.prioridade,
        is_recurring: p.recorrente,
        decay_type: p.tipo,
        category: cat,
        emotional_weight:
          p.prioridade === 'alta'
            ? 0.9
            : p.prioridade === 'media'
            ? 0.6
            : 0.3,
      });
      return `Evento "${p.titulo}" salvo.`;
    }

    case 'atualizar_meta':
      return await updateGoalProgress(
        numericUserIdStr,
        p.titulo_parcial,
        p.progresso,
        p.etapa_concluida
      );

    case 'registrar_no_diario':
      await extractDiary(
        numericUserIdStr,
        p.texto,
        p.categoria || 'anytime'
      );
      return 'Entrada registrada no diário.';

    // Alias mantido para retrocompatibilidade
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
      const { error } = await supabase.from('favorite_places').upsert(
        {
          user_id: authUserId,
          name: p.nome.trim(),
          lat: p.lat,
          lng: p.lng,
          radius_meters: p.raio_metros,
          category: p.categoria.trim(),
        },
        { onConflict: 'user_id,name' }
      );
      return error ? `Erro: ${error.message}` : `Lugar "${p.nome}" salvo.`;
    }

    case 'remover_lugar':
      await supabase
        .from('favorite_places')
        .delete()
        .eq('user_id', authUserId)
        .ilike('name', p.nome.trim());
      return `Lugar "${p.nome}" removido.`;

    case 'adicionar_item_lista': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
      await supabase.from('shopping_items').upsert(
        {
          user_id: authUserId,
          item: p.item.trim(),
          place_id: pid,
          done: false,
        },
        { onConflict: 'user_id,item,place_id' }
      );
      return `"${p.item}" adicionado à lista de ${p.lugar}.`;
    }

    case 'marcar_feito': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
      await supabase
        .from('shopping_items')
        .update({ done: true })
        .eq('user_id', authUserId)
        .ilike('item', p.item.trim())
        .eq('place_id', pid);
      return `"${p.item}" marcado como comprado.`;
    }

    case 'remover_item_lista': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
      await supabase
        .from('shopping_items')
        .delete()
        .eq('user_id', authUserId)
        .ilike('item', p.item.trim())
        .eq('place_id', pid);
      return `"${p.item}" removido.`;
    }

    case 'ver_lista': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lista de ${p.lugar} está vazia.`;
      const { data: itens } = await supabase
        .from('shopping_items')
        .select('item, done')
        .eq('user_id', authUserId)
        .eq('place_id', pid)
        .order('done');
      if (!itens?.length) return `Lista de ${p.lugar} está vazia.`;
      return `Lista de ${p.lugar}:\n${itens
        .map((i: any) => `${i.done ? '✅' : '•'} ${i.item}`)
        .join('\n')}`;
    }

    default:
      return `Ferramenta ${name} não implementada.`;
  }
}

// ============================================================
// callOpenRouterWithTools
// CORREÇÃO: usa OPENROUTER_API_KEY (não OPENAI_API_KEY)
// ============================================================
interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface ToolResponse {
  content: string;
  toolCalls: ToolCall[] | null;
}

async function callOpenRouterWithTools(
  messages: any[],
  toolsDef: any[],
  model: string,
  temperature: number,
  timeoutMs = 25000
): Promise<ToolResponse> {
  const response = await Promise.race([
    fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        // CORREÇÃO 3: era OPENAI_API_KEY — trocado para OPENROUTER_API_KEY
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer':
          process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Lev',
      },
      body: JSON.stringify({
        model,
        messages,
        tools: toolsDef,
        tool_choice: 'auto',
        temperature,
        max_tokens: 2000,
      }),
    }),
    new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    ),
  ]);
  if (!response.ok) throw new Error(`OpenRouter error: ${response.status}`);
  const data = await response.json();
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content || '',
    toolCalls: choice?.message?.tool_calls || null,
  };
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  delayMs = 1000
): Promise<T | null> {
  let lastError: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < maxRetries) {
        console.warn(`Retry ${i + 1}/${maxRetries} após erro:`, e);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  console.error('Falha após retries:', lastError);
  return null;
}

// ============================================================
// POST — Handler Principal
// ============================================================
export async function POST(req: NextRequest) {
  console.log('[chat] 1. Iniciando parse HÍBRIDO (V8 + fixes)');
  try {
    console.time('[Performance] total');

    let messageText: string = '';
    let userEmail: string = '';
    let tempUserId: string = '';
    let clientSessionId: string | null = null;
    let userFirstName = 'Usuário';
    let location: { latitude: number; longitude: number } | null = null;

    // ----------------------------------------------------------
    // Parse Híbrido: Áudio (FormData) vs Texto (JSON)
    // ----------------------------------------------------------
    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const audioFile = formData.get('audio') as File | null;

      userEmail =
        (formData.get('userEmail') as string) ||
        (formData.get('email') as string) ||
        '';
      tempUserId =
        (formData.get('userId') as string) ||
        (formData.get('user_id') as string) ||
        '';
      clientSessionId = formData.get('sessionId') as string | null;
      userFirstName =
        (formData.get('userFirstName') as string) || 'Usuário';

      const latField = formData.get('latitude') as string | null;
      const lngField = formData.get('longitude') as string | null;
      if (latField && lngField)
        location = {
          latitude: parseFloat(latField),
          longitude: parseFloat(lngField),
        };

      if (
        !audioFile &&
        !formData.get('message') &&
        !formData.get('text')
      ) {
        return NextResponse.json(
          { error: 'Áudio ou texto obrigatório' },
          { status: 400 }
        );
      }

      if (audioFile) {
        const buffer = Buffer.from(await audioFile.arrayBuffer());
        const whisperFormData = new FormData();
        whisperFormData.append('file', new Blob([buffer]), 'audio.ogg');
        whisperFormData.append('model', 'whisper-1');
        whisperFormData.append('language', 'pt');

        // Whisper continua usando OPENAI_API_KEY (é a API da OpenAI mesmo)
        const whisperRes = await fetch(
          'https://api.openai.com/v1/audio/transcriptions',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: whisperFormData,
          }
        );

        if (!whisperRes.ok)
          return NextResponse.json(
            { error: 'Falha na transcrição' },
            { status: 500 }
          );
        const whisperData = await whisperRes.json();
        messageText = whisperData.text?.trim() || '';
      } else {
        messageText =
          (formData.get('message') as string) ||
          (formData.get('text') as string) ||
          '';
      }
    } else {
      const body = await req.json();
      messageText = body.message || body.text || '';
      userEmail = body.userEmail || body.email || '';
      tempUserId = body.userId || body.user_id || '';
      clientSessionId = body.sessionId || null;
      userFirstName =
        body.userFirstName || body.user_first_name || 'Usuário';

      if (
        body.location &&
        typeof body.location.latitude === 'number' &&
        typeof body.location.longitude === 'number'
      ) {
        location = {
          latitude: body.location.latitude,
          longitude: body.location.longitude,
        };
      }
    }

    console.log(
      '[chat] 2. message:',
      messageText?.slice(0, 30),
      '| email:',
      userEmail,
      '| userId:',
      tempUserId
    );

    if (!messageText && !location)
      return NextResponse.json(
        { error: 'message obrigatório' },
        { status: 400 }
      );

    // ----------------------------------------------------------
    // CORREÇÃO 1: Lookup do usuário — aceita email OU userId (fallback robusto)
    // Garante retrocompatibilidade: clientes que enviam só userId continuam funcionando.
    // ----------------------------------------------------------
    if (!userEmail && !tempUserId) {
      return NextResponse.json(
        { error: 'userEmail ou userId obrigatório' },
        { status: 400 }
      );
    }

    let userRecord: any = null;

    // Tenta por email primeiro (forma canônica)
    if (userEmail) {
      const { data } = await supabase
        .from('users')
        .select(
          'id, nickname, current_context, assistant_name, timezone, pending_question, pending_context'
        )
        .eq('email', userEmail)
        .maybeSingle();
      userRecord = data;
    }

    // Fallback por UUID direto (retrocompatibilidade com clientes antigos)
    if (!userRecord && tempUserId) {
      const { data } = await supabase
        .from('users')
        .select(
          'id, nickname, current_context, assistant_name, timezone, pending_question, pending_context'
        )
        .eq('id', tempUserId)
        .maybeSingle();
      userRecord = data;
    }

    if (!userRecord) {
      return NextResponse.json(
        { error: 'Usuário não encontrado' },
        { status: 404 }
      );
    }

    // ----------------------------------------------------------
    // ARQUITETURA DUAL-ID:
    // numericUserIdStr → TODAS as tabelas do schema jarvis, incluindo brain
    //                    (bigint): events, topic_index, goals, diary, children,
    //                    person_notes, brain, sessions, memories, config
    // authUserId       → favorite_places e shopping_items (text/uuid, schema público)
    //                    Fallback: se tempUserId for UUID do Auth, usado só nessas duas tabelas
    // ----------------------------------------------------------
    const numericUserIdStr = String(userRecord.id);
    // authUserId: para favorite_places/shopping_items que podem usar UUID do Auth
    // Se tempUserId for um UUID válido (contém '-'), usa ele; caso contrário usa numérico
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(tempUserId);
    const authUserId = isUUID ? tempUserId : numericUserIdStr;

    const authorName = userRecord.nickname || userFirstName;
    const assistantName = userRecord.assistant_name || 'Lev';
    const userTimezone = userRecord.timezone || 'America/Sao_Paulo';
    const currentContextL3 =
      userRecord.current_context || 'Sem dossiê ainda.';

    // CORREÇÃO 2: pending_question restaurado — lido direto do userRecord
    const pendingQuestion = userRecord.pending_question || null;

    ensureMemoryHealth(numericUserIdStr).catch((e) =>
      console.error('[Health] Erro em background:', e)
    );

    const sessionId =
      clientSessionId || (await getOrCreateSession(numericUserIdStr));

    // ----------------------------------------------------------
    // Processamento de Localização
    // ----------------------------------------------------------
    let locationContext = '';
    if (location) {
      const { latitude, longitude } = location;
      const endereco = await checkProximidade(latitude, longitude);
      locationContext = `${endereco}\nCoordenadas exatas: ${latitude}, ${longitude}`;
      await supabase.from('config').upsert(
        {
          key: `last_location_${numericUserIdStr}`,
          value: JSON.stringify({
            latitude,
            longitude,
            endereco,
            ts: Date.now(),
          }),
        },
        { onConflict: 'key' }
      );
      const alertaGeo = await verificarAlertasDeProximidade(
        authUserId,
        latitude,
        longitude
      );
      if (alertaGeo.temAlerta) {
        return NextResponse.json({
          reply: alertaGeo.mensagem,
          sessionId,
          ok: true,
        });
      }
      if (!messageText) messageText = '[Enviou Localização]';
    } else {
      // Recupera última localização conhecida (até 60 min atrás)
      const { data: lastLoc } = await supabase
        .from('config')
        .select('value')
        .eq('key', `last_location_${numericUserIdStr}`)
        .single();
      if (lastLoc?.value) {
        try {
          const loc = JSON.parse(lastLoc.value);
          const idadeMinutos = (Date.now() - loc.ts) / 60000;
          if (idadeMinutos <= 60) {
            locationContext = `${loc.endereco}\nCoordenadas exatas: ${loc.latitude}, ${loc.longitude} (compartilhada há ${Math.round(idadeMinutos)} min)`;
          }
        } catch {
          /* ignore */
        }
      }
    }

    // ----------------------------------------------------------
    // Classificação de Contexto, Tópicos e Roteamento
    // ----------------------------------------------------------
    console.time('[Performance] context_classification');
    const detectedContexts = await classifyContextWithL4(
      messageText,
      numericUserIdStr
    );
    console.timeEnd('[Performance] context_classification');

    const modelRoute = routeModel(detectedContexts);
    const temperature = getTemperature(detectedContexts);
    const blockPlan = planContextualBlocks(detectedContexts);
    console.log(
      '[chat] contexts:',
      detectedContexts,
      '| model:',
      modelRoute.label
    );

    await updateTopicIndex(numericUserIdStr, detectedContexts, messageText);
    const relatedTopicsBlock = await getRelatedTopics(
      numericUserIdStr,
      detectedContexts[0] || 'casual'
    );

    // ----------------------------------------------------------
    // Pesquisa forçada
    // ----------------------------------------------------------
    let forcedSearchResult = '';
    if (shouldForceSearch(messageText, detectedContexts)) {
      const searchQuery = refineSearchQuery(messageText, detectedContexts);
      console.log('[chat] ForcedSearch Query:', searchQuery);
      try {
        const result = await searchWeb(searchQuery);
        forcedSearchResult = `\n[PESQUISA AUTOMÁTICA REALIZADA]\nConsulta: "${searchQuery}"\nResultado:\n${result}`;
        console.log(
          '[chat] ForcedSearch ok (200):',
          result.substring(0, 200)
        );
      } catch (e) {
        console.error('[chat] ForcedSearch falhou:', e);
        forcedSearchResult =
          '\n[ERRO NA PESQUISA] Não foi possível obter informações atualizadas.';
      }
    }

    // ----------------------------------------------------------
    // Cargas contextuais paralelas
    // ----------------------------------------------------------
    const basePromises = Promise.all([
      supabase
        .from('events')
        .select(
          'title, event_date, category, decay_type, relevance_score, emotional_weight, is_recurring, notes'
        )
        .eq('user_id', numericUserIdStr)
        .order('relevance_score', { ascending: false }),
      supabase
        .from('memory_ashes')
        .select('ash_summary, period_start, period_end')
        .eq('user_id', numericUserIdStr)
        .order('period_end', { ascending: false })
        .limit(5),
      supabase
        .from('onboarding_progress')
        .select('*')
        .eq('user_id', numericUserIdStr)
        .single(),
      buildGapsBlock(numericUserIdStr, messageText),
      supabase
        .from('principles')
        .select('content, category')
        .order('created_at', { ascending: true }),
    ]);

    const conditionalTasks: Promise<any>[] = [];
    if (blockPlan.loadCalendar) {
      conditionalTasks.push(getGoogleContext().catch(() => null));
      conditionalTasks.push(
        getMicrosoftCalendarContext().catch(() => null)
      );
    }
    if (blockPlan.loadEmail)
      conditionalTasks.push(
        getRecentEmails(undefined, 3, false).catch(() => null)
      );
    if (blockPlan.loadTopics)
      conditionalTasks.push(
        buildTopicBlock(numericUserIdStr, messageText).catch(() => '')
      );
    if (blockPlan.loadDiary)
      conditionalTasks.push(
        buildDiaryGoalsBlock(numericUserIdStr).catch(() => '')
      );

    const [
      [
        eventsResult,
        ashesResult,
        onboardingResult,
        gapsBlock,
        principlesResult,
      ],
      conditionalResults,
    ] = await Promise.all([basePromises, Promise.all(conditionalTasks)]);

    let ri = 0;
    const googleCtx = blockPlan.loadCalendar
      ? conditionalResults[ri++]
      : null;
    const msCtx = blockPlan.loadCalendar
      ? conditionalResults[ri++]
      : null;
    const emailBlock = blockPlan.loadEmail
      ? conditionalResults[ri++]
      : null;
    const topicBlock = blockPlan.loadTopics
      ? conditionalResults[ri++] || ''
      : '';
    const diaryBlock = blockPlan.loadDiary
      ? conditionalResults[ri++] || ''
      : '';

    const recsBlock = blockPlan.loadRecommendations
      ? await buildRecommendationsBlock(
          numericUserIdStr,
          messageText
        ).catch(() => '')
      : '';

    // Princípios e Onboarding
    const principles = principlesResult?.data || [];
    const principlesBlock =
      principles.length > 0
        ? principles.map((p: any) => `- ${p.content}`).join('\n')
        : '';

    let onboardingState = onboardingResult?.data || null;
    if (!onboardingState)
      onboardingState =
        await getOrCreateOnboardingStatePersistent(numericUserIdStr);
    const onboardingBlock = buildOnboardingBlock(onboardingState);

    // Eventos
    const events = eventsResult.data || [];
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const sortedEvents = [...events].sort(
      (a, b) =>
        Math.abs(new Date(a.event_date).getTime() - hoje.getTime()) -
        Math.abs(new Date(b.event_date).getTime() - hoje.getTime())
    );
    const upcomingEvents = sortedEvents.filter((e) => {
      const diff = Math.ceil(
        (new Date(e.event_date).getTime() - hoje.getTime()) / 86400000
      );
      return diff >= 0 && diff <= 7;
    });
    const highRelevanceEvents = sortedEvents.filter(
      (e) =>
        (e.relevance_score || 0) >= 0.7 && !upcomingEvents.includes(e)
    );
    const activeEvents = sortedEvents.filter(
      (e) =>
        new Date(e.event_date) >= hoje ||
        (e.decay_type === 'permanent' && new Date(e.event_date) < hoje)
    );
    const eventsBlock =
      activeEvents.length > 0
        ? [
            upcomingEvents.length > 0
              ? `🔴 NOS PRÓXIMOS DIAS:\n${upcomingEvents
                  .map(
                    (e) =>
                      `  - ${e.title}: ${e.event_date}${
                        e.notes ? ` (${e.notes})` : ''
                      }`
                  )
                  .join('\n')}`
              : null,
            highRelevanceEvents.length > 0
              ? `🟡 IMPORTANTES:\n${highRelevanceEvents
                  .map((e) => `  - ${e.title}: ${e.event_date}`)
                  .join('\n')}`
              : null,
          ]
            .filter(Boolean)
            .join('\n\n')
        : 'Nenhum evento cadastrado.';

    const ashes = ashesResult.data || [];
    const ashesBlock =
      ashes.length > 0
        ? ashes.map((a: any) => a.ash_summary).join('\n')
        : null;

    // Notas de pessoas
    let personNotesBlock = '';
    const [childrenResult, personNotesResult] = await Promise.all([
      supabase
        .from('children')
        .select('name, nickname, lev_notes')
        .eq('parent_id', numericUserIdStr)
        .not('lev_notes', 'is', null),
      supabase
        .from('person_notes')
        .select('person_name, person_type, note, noted_at')
        .eq('user_id', numericUserIdStr)
        .order('noted_at', { ascending: false })
        .limit(20),
    ]);
    const msgLower = messageText.toLowerCase();
    const childNotes = (childrenResult.data || []).filter(
      (c: any) =>
        msgLower.includes((c.nickname || '').toLowerCase()) ||
        msgLower.includes((c.name || '').split(' ')[0].toLowerCase())
    );
    const pNotes = (personNotesResult.data || []).filter((n: any) =>
      n.person_name
        .toLowerCase()
        .split(' ')
        .some(
          (p: string) =>
            p.length >= 3 && new RegExp(`\\b${p}\\b`).test(msgLower)
        )
    );

    if (childNotes.length > 0 || pNotes.length > 0) {
      const lines: string[] = [];
      for (const c of childNotes)
        lines.push(
          `${c.nickname || c.name.split(' ')[0]}: ${c.lev_notes}`
        );
      for (const n of pNotes)
        lines.push(`${n.person_name} [${n.noted_at}]: ${n.note}`);
      personNotesBlock = `[NOTAS SOBRE PESSOAS MENCIONADAS]\n${lines.join('\n')}`;
    }

    // HD Vetorial & RAM Compressão
    const queryEmbedding = await getCachedEmbedding(messageText);
    let hdBlock = '';
    let hdMemoryIds: string[] = [];
    if (queryEmbedding) {
      const { data: search } = (await supabase.rpc('match_memories', {
        query_embedding: queryEmbedding,
        match_threshold: 0.4,
        match_count: 3,
      })) as { data: any[] | null };
      if (search?.length) {
        hdBlock = search
          .filter((r: any) => !r.summary.startsWith('[CINZA]'))
          .map((r: any) => r.summary)
          .join('\n---\n');
        hdMemoryIds = search.map((r: any) => r.id);
      }
    }

    let ramBlock = '';
    const { data: historySession } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('user_id', numericUserIdStr)
      .eq('session_id', sessionId)
      .neq('category', 'archived')
      .order('created_at', { ascending: false })
      .limit(10);

    const topicShifted = await detectTopicShiftWithL4(
      numericUserIdStr,
      detectedContexts
    );

    if (historySession && historySession.length >= 2) {
      if (topicShifted) {
        const summary = compressToSummary(historySession.slice(3));
        const recentRaw = [...historySession]
          .slice(0, 3)
          .reverse()
          .map(
            (h: any) =>
              `${authorName}: ${h.content}\n${assistantName}: ${(
                h.metadata?.ai_reply || ''
              )
                .replace(/\[.*?\]/g, '')
                .trim()}`
          )
          .join('\n\n');
        ramBlock = `${summary}\n\n${recentRaw}`;
      } else {
        ramBlock = [...historySession]
          .reverse()
          .map(
            (h: any) =>
              `${authorName}: ${h.content}\n${assistantName}: ${(
                h.metadata?.ai_reply || ''
              )
                .replace(/\[.*?\]/g, '')
                .trim()}`
          )
          .join('\n\n');
      }
    } else {
      const semanticBlock = await semanticRamCompression(
        historySession || [],
        numericUserIdStr,
        messageText,
        queryEmbedding
      );
      ramBlock =
        semanticBlock ||
        (hdBlock ? `[Contexto anterior consolidado]\n${hdBlock}` : '');
    }
    if (ramBlock.length > RAM_MAX_CHARS)
      ramBlock = ramBlock.slice(-RAM_MAX_CHARS);

    // Classificação Temporal
    const weights = classifyTemporalHorizon(
      messageText,
      ramBlock,
      pendingQuestion
    );
    const truncatedL3 = truncateByWeight(currentContextL3, weights.l3, 6000);
    const truncatedHd = truncateByWeight(hdBlock, weights.hd, 6000);
    const truncatedAshes = ashesBlock
      ? truncateByWeight(ashesBlock, weights.ashes, 6000)
      : null;
    const truncatedEvents = truncateByWeight(
      eventsBlock,
      weights.events,
      6000
    );
    const fusoHorario = new Date().toLocaleString('pt-BR', {
      timeZone: userTimezone,
    });

    const isFemale =
      currentContextL3.toLowerCase().includes('feminino') ||
      currentContextL3.toLowerCase().includes('mulher');
    const informalAddress = isFemale ? 'miga' : 'cara';

    // ----------------------------------------------------------
    // System Prompt Final
    // ----------------------------------------------------------
    const systemPrompt = `Você é ${assistantName}, assistente pessoal de ${authorName}.
Data/hora: ${fusoHorario} | Modo: ${weights.horizon.toUpperCase()}

🚨 REGRA ABSOLUTA – PESQUISE SEMPRE! 🚨
Para QUALQUER pergunta sobre:
- Jogos, partidas, resultados esportivos (futebol, basquete, F1, etc.)
- Datas e horários de eventos futuros
- Notícias recentes, cotações, clima em outras cidades
- Escalações de times, tabelas de campeonatos
- Qualquer informação que possa ter mudado desde ontem

VOCÊ DEVE chamar a ferramenta \`searchWeb\` ANTES de responder.

ATENÇÃO: Se o bloco "[PESQUISA AUTOMÁTICA REALIZADA]" estiver presente, você DEVE usá-lo como fonte principal e NÃO inventar informações.

${forcedSearchResult}

${googleCtx ? `[AGENDA GOOGLE]\n${googleCtx}` : ''}
${msCtx ? `[AGENDA OUTLOOK]\n${msCtx}` : ''}
${emailBlock ? `[EMAILS RECENTES]\n${emailBlock}` : ''}
${locationContext ? `\n${locationContext}` : ''}
${relatedTopicsBlock ? relatedTopicsBlock : ''}

${truncatedL3 ? `[QUEM É ${authorName.toUpperCase()}]\n${truncatedL3}` : ''}

${personNotesBlock ? personNotesBlock : ''}
${recsBlock ? recsBlock : ''}
${topicBlock ? topicBlock : ''}
${isMeaningfulDiaryBlock(diaryBlock) ? diaryBlock : ''}

${truncatedHd ? `[MEMÓRIAS DE LONGO PRAZO]\n${truncatedHd}` : ''}
${truncatedAshes ? `[MEMÓRIAS DISTANTES — use "lembro vagamente que..." ao citar]\n${truncatedAshes}` : ''}

[EVENTOS]\n${truncatedEvents}

${onboardingBlock}
${gapsBlock ? gapsBlock : ''}

${principlesBlock ? `[BÚSSOLA — seu jeito de ser no mundo, não regras a citar]\n${principlesBlock}` : ''}

REGRAS COMPORTAMENTAIS:
1. FOCO: Responda O QUE FOI PERGUNTADO. Pronomes referem-se ao último assunto. Nunca repita sugestão rejeitada.
2. TOM: Amigo inteligente, direto, humano. Use "${informalAddress}" no máximo 1x por conversa. Nunca comece com "Considerando que".
3. PROIBIDO: "Anotado!", "Registrado!". Se salvou via ferramenta, diga naturalmente: "Feito." ou "Tá na agenda."
4. PRESENÇA EMOCIONAL: Seja empático quando compartilhado algo difícil.
5. MEMÓRIA: Use notas naturalmente. Nunca diga "Tenho uma nota aqui que diz...".
6. FAMÍLIA: Nunca assuma que a mãe/pai de um filho é o cônjuge atual.
7. LOCALIZAÇÃO: Se disponível, use para contextualizar – não cite coordenadas.
8. PERGUNTA PENDENTE: ${pendingQuestion ? `Você fez esta pergunta: "${pendingQuestion}". A mensagem atual é a resposta — processe adequadamente e limpe a pendência.` : 'Nenhuma pergunta pendente.'}
9. CLASSIFICAÇÃO: Ao final da sua resposta, inclua obrigatoriamente [CLASSE: info] ou [CLASSE: noise].`.trim();

    // ----------------------------------------------------------
    // Montagem do Histórico
    // ----------------------------------------------------------
    const { data: historyForMessages } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('user_id', numericUserIdStr)
      .neq('category', 'archived')
      .order('created_at', { ascending: false })
      .limit(8);

    const conversationMessages: any[] = [
      { role: 'system', content: systemPrompt },
      ...(historyForMessages || []).reverse().flatMap((h: any) => [
        { role: 'user', content: h.content },
        {
          role: 'assistant',
          content: (h.metadata?.ai_reply || '')
            .replace(/\[.*?\]/g, '')
            .trim(),
        },
      ]),
      { role: 'user', content: messageText },
    ];

    // Comandos especiais
    if (
      /ignore isso|ignora isso|não salva|nao salva|apaga isso|esquece isso|delete isso/i.test(
        messageText
      )
    ) {
      const { data: lastEntry } = await supabase
        .from('brain')
        .select('id')
        .eq('user_id', numericUserIdStr)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (lastEntry) await supabase.from('brain').delete().eq('id', lastEntry.id);
      return NextResponse.json({
        reply: 'Feito — apaguei o que foi dito antes. 🗑️',
        sessionId,
        ok: true,
      });
    }

    const noisePatterns =
      /^(ok|oi|olá|ola|bom dia|boa tarde|boa noite|tudo bem|tudo bom|blz|vlw|valeu|obrigad|kkk|haha|rs|👍|🙏|😂|!)[\s!?.]*$/i;
    const isLikelyNoise =
      noisePatterns.test(messageText.trim()) && messageText.length < 30;

    let extractionSummary = '';
    if (!isLikelyNoise) {
      try {
        extractionSummary = await extractAndSummarize(
          numericUserIdStr,
          authorName,
          messageText
        );
      } catch (e) {
        console.error('[Extrator/pre] Erro:', e);
      }
    }

    const feedbackContent = extractionSummary
      ? `[INTERNO]\nRegistrado: ${extractionSummary}\nConfirme em 1 frase curta. PROIBIDO: "Anota aí", "Anotado!", "Registrado!".`
      : `[INTERNO]\nVocê é o assistente — NUNCA diga "Anota aí". Confirme brevemente.`;
    conversationMessages.push({ role: 'system', content: feedbackContent });

    // ----------------------------------------------------------
    // ReAct Loop
    // ----------------------------------------------------------
    console.log('[chat] Chamando OpenRouter (model:', modelRoute.model, ')');
    let finalResponse = '';
    let attempts = 0;
    while (attempts < 5) {
      const response = await callOpenRouterWithTools(
        conversationMessages,
        tools,
        modelRoute.model,
        temperature,
        25000
      );
      const { content, toolCalls } = response;

      if (!toolCalls || toolCalls.length === 0) {
        finalResponse = content;
        break;
      }

      conversationMessages.push({
        role: 'assistant',
        content: null,
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const result = await executeTool(
          toolCall,
          authUserId,
          numericUserIdStr
        );
        conversationMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      attempts++;
    }

    if (!finalResponse)
      finalResponse = 'Ops, não consegui processar. Pode repetir?';

    let category = 'info';
    const categoryMatch = finalResponse.match(/\[CLASSE:\s*(\w+)\]/i);
    if (categoryMatch) category = categoryMatch[1].toLowerCase();
    finalResponse = finalResponse.replace(/\[CLASSE:\s*\w+\]/gi, '').trim();

    if (!finalResponse && extractionSummary) {
      const feedbacks = ['Certo.', 'Ok.', 'Guardei.', 'Entendido.'];
      finalResponse =
        feedbacks[Math.floor(Math.random() * feedbacks.length)];
    }

    // ----------------------------------------------------------
    // Limpeza de pergunta pendente (se havia uma e foi respondida)
    // CORREÇÃO 2: clearPendingQuestion restaurado
    // ----------------------------------------------------------
    if (pendingQuestion) {
      clearPendingQuestion(numericUserIdStr).catch((e) =>
        console.error('[PendingQ] Erro ao limpar:', e)
      );
    }

    // ----------------------------------------------------------
    // Persistência no banco
    // brain.user_id é bigint → usa numericUserIdStr
    // ----------------------------------------------------------
    const { error: insertError } = await supabase.from('brain').insert([
      {
        content: messageText,
        category,
        user_id: numericUserIdStr,
        session_id: sessionId,
        project_tag: 'geral',
        embedding: queryEmbedding,
        metadata: {
          ai_reply: finalResponse,
          user: authorName,
          horizon: weights.horizon,
          pending_resolved: !!pendingQuestion,
          model_used: modelRoute.model,
          model_label: modelRoute.label,
          temperature_used: temperature,
          contexts_detected: detectedContexts,
          forced_search_used: !!forcedSearchResult,
        },
      },
    ]);

    if (insertError) console.error('BRAIN INSERT ERRO:', insertError);
    else
      console.log(
        'BRAIN INSERT OK — user:',
        numericUserIdStr,
        'session:',
        sessionId,
        'model:',
        modelRoute.label
      );

    // Background tasks
    const backgroundTasks: Promise<any>[] = hdMemoryIds.map((id) =>
      reinforceMemory(id)
    );

    if (onboardingState?.status === 'in_progress') {
      backgroundTasks.push(
        withRetry(() =>
          processOnboardingFromMessage(
            numericUserIdStr,
            messageText,
            finalResponse,
            onboardingState
          )
        ).catch((e) => console.error('[Onboarding] Erro:', e))
      );
    }

    if (!isLikelyNoise) {
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
        withRetry(() => extractGoal(numericUserIdStr, messageText)).catch(
          (e) => console.error('[goals] Erro:', e)
        )
      );
    }

    Promise.all([
      ...backgroundTasks,
      supabase
        .from('brain')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', numericUserIdStr)
        .eq('category', 'info')
        .then(({ count }) => {
          if (count && count >= 20)
            return compactMemory(numericUserIdStr, authorName);
        }),
    ]).catch((e) => console.error('[Background] Erro:', e));

    console.timeEnd('[Performance] total');
    return NextResponse.json({
      reply: finalResponse,
      sessionId,
      ok: true,
    });
  } catch (error: any) {
    console.error('[chat] ERRO:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}