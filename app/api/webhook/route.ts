// app/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server';
import {
  supabase,
  callOpenRouter,
  generateEmbedding,
  compactMemory,
  getOrCreateSession,
  setPendingQuestion,
  clearPendingQuestion,
  reinforceMemory
} from '@/lib/jarvis';
import {
  createOutlookEvent,
  updateOutlookEvent,
  getRecentEmails,
  addEmailKeyword,
  removeEmailKeyword,
  getMicrosoftCalendarContext
} from '@/lib/microsoft';
import {
  getGoogleContext,
  createGoogleEvent,
  updateGoogleEvent,
  deleteGoogleEvent,
  searchWeb,
  getWeatherForecast
} from '@/lib/google';
import { checkProximidade } from '@/lib/geo';
import { verificarAlertasDeProximidade } from '@/lib/geo-alerts';
import {
  classifyTemporalHorizon,
  truncateByWeight
} from '@/lib/context-router';
import {
  initOnboarding,
  processOnboardingFromMessage,
  buildOnboardingBlock
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
    const diffDays = Math.ceil((eventDate.getTime() - hoje.getTime()) / (1000 * 3600 * 24));
    let newScore = 0;
    switch (ev.decay_type) {
      case 'recurring_annual':
        if (diffDays < -30) newScore = 0;
        else if (diffDays <= 0) newScore = 0.9 + (diffDays === 0 ? 0.1 : 0);
        else if (diffDays <= 30) newScore = 0.3 + (0.6 * (1 - diffDays / 30));
        else newScore = 0;
        break;
      case 'deadline':
        if (diffDays < -7) newScore = 0;
        else if (diffDays <= 0) newScore = 0.9 + (diffDays === 0 ? 0.1 : 0);
        else if (diffDays <= 7) newScore = 0.3 + (0.6 * (1 - diffDays / 7));
        else newScore = 0;
        break;
      case 'one_time':
        if (diffDays < -14) newScore = 0;
        else if (diffDays <= 0) newScore = 0.9 + (diffDays === 0 ? 0.1 : 0);
        else if (diffDays <= 14) newScore = 0.2 + (0.7 * (1 - diffDays / 14));
        else newScore = 0;
        break;
      default:
        if (diffDays < 0) newScore = Math.max(0, (ev.relevance_score || 0) * 0.95);
        else newScore = ev.relevance_score || 0;
    }
    newScore = Math.min(0.95, Math.max(0, newScore));
    if (Math.abs(newScore - (ev.relevance_score || 0)) > 0.01) {
      updates.push({ id: ev.id, relevance_score: newScore });
    }
  }
  if (updates.length) {
    for (const upd of updates) {
      await supabase.from('events').update({ relevance_score: upd.relevance_score }).eq('id', upd.id);
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
      .lt('last_mentioned', new Date(Date.now() - 30*24*60*60*1000).toISOString());
    if (topics && topics.length) {
      for (const topic of topics) {
        const newWeight = (topic.weight || 0) * 0.95;
        await supabase.from('topic_index').update({ weight: newWeight }).eq('id', topic.id);
      }
      console.log(`[Health] Decaimento L4: ${topics.length} tópicos atualizados`);
    }
  } catch (e) {
    console.error('[Health] Erro no health check:', e);
  }
}

// ============================================================
// Atualização do índice de tópicos (L4)
// ============================================================
async function updateTopicIndex(userId: string, contexts: string[], messageText: string) {
  if (!contexts.length) return;
  const words = messageText.toLowerCase().split(/\s+/);
  const keyTerms = words.filter(w => w.length > 3 && !/[0-9]/.test(w)).slice(0, 5);
  for (const ctx of contexts) {
    const { data: existing } = await supabase
      .from('topic_index')
      .select('weight')
      .eq('user_id', userId)
      .eq('topic', ctx)
      .maybeSingle();
    const newWeight = (existing?.weight || 0) + 0.1;
    await supabase
      .from('topic_index')
      .upsert({
        user_id: userId,
        topic: ctx,
        weight: newWeight,
        last_mentioned: new Date().toISOString(),
        related_terms: keyTerms
      }, { onConflict: 'user_id,topic' });
  }
}

// ============================================================
// Busca tópicos relacionados via L4
// ============================================================
async function getRelatedTopics(userId: string, currentContext: string): Promise<string> {
  const { data: related } = await supabase
    .from('topic_index')
    .select('topic, weight')
    .eq('user_id', userId)
    .neq('topic', currentContext)
    .order('weight', { ascending: false })
    .limit(3);
  if (!related?.length) return '';
  return `\n[TÓPICOS RELACIONADOS]\n${related.map((t: any) => `- ${t.topic} (peso: ${Math.round(t.weight * 100)}%)`).join('\n')}`;
}

// ============================================================
// Classificação de contexto (regex + L4) – com esportes, notícias, clima
// ============================================================
type ContextType =
  | 'agenda' | 'projeto' | 'familia' | 'emocao' | 'diario' | 'meta'
  | 'saude' | 'recomendacao' | 'evento' | 'rotina' | 'preferencia'
  | 'alias' | 'email' | 'casual' | 'esporte' | 'noticias' | 'clima';

function classifyContextRegex(text: string): ContextType[] {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const rules: Array<[RegExp, ContextType]> = [
    [/diario|diário|hoje foi|hoje ta|hoje está|acordei|dormi|dormir|meu dia|como foi meu|reflexao|refletindo|gratid/i, 'diario'],
    [/meta|objetivo|quero (conseguir|fazer|terminar|lancar|comecar)|prazo|progresso|etapa|concluir|finalizar/i, 'meta'],
    [/reuniao|reunião|consulta|compromisso|agend|horario|horário|amanha as|amanhã às|segunda|terça|quarta|quinta|sexta|sabado|domingo|às \d|as \d{1,2}h/i, 'agenda'],
    [/projeto|app|aplicativo|sistema|api|deploy|feature|sprint|mvp|startup|produto|desenvolv/i, 'projeto'],
    [/filho|filha|esposa|marido|mae|mãe|pai|irmao|irmão|família|familia|cônjuge|conjuge|casamento|nasceu|aniversario de casamento/i, 'familia'],
    [/medic|médic|saude|saúde|exame|remedio|remédio|hospital|dor |doenca|doença|sintoma|consulta médica/i, 'saude'],
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
      .from('topic_index')
      .select('topic, weight')
      .eq('user_id', userId)
      .in('topic', regexContexts);
    if (topicWeights && topicWeights.length > 0) {
      const sorted = topicWeights.sort((a, b) => (b.weight || 0) - (a.weight || 0));
      const prioritized = sorted.map(t => t.topic as ContextType);
      const missing = regexContexts.filter(c => !prioritized.includes(c));
      return [...prioritized, ...missing];
    }
  }
  return regexContexts;
}

// ============================================================
// RAM Compression (semântica)
// ============================================================
async function semanticRamCompression(history: any[], userId: string, currentContext: string, currentEmbedding?: number[]): Promise<string> {
  if (!history.length) return '';
  const embedding = currentEmbedding || await getCachedEmbedding(currentContext);
  const { data: relevantMemories } = await supabase.rpc('match_memories', {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 5
  }) as { data: any[] | null };
  if (relevantMemories && relevantMemories.length > 0) {
    const semanticBlock = relevantMemories
      .filter((r: any) => !r.summary.startsWith('[CINZA]'))
      .map((r: any) => r.summary)
      .join('\n---\n');
    return `[MEMÓRIAS SEMANTICAMENTE RELEVANTES]\n${semanticBlock}`;
  }
  return '';
}

// ============================================================
// Topic Shift Detection
// ============================================================
async function detectTopicShiftWithL4(userId: string, currentContexts: ContextType[]): Promise<boolean> {
  const { data: recentTopics } = await supabase
    .from('topic_index')
    .select('topic, weight')
    .eq('user_id', userId)
    .order('last_mentioned', { ascending: false })
    .limit(5);
  if (!recentTopics?.length) return false;
  const hasCurrentTopic = currentContexts.some(ctx =>
    recentTopics.some((t: any) => t.topic === ctx && (t.weight || 0) >= 0.3)
  );
  return !hasCurrentTopic && !currentContexts.includes('casual');
}

// ============================================================
// Onboarding persistente
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

const RAM_MAX_CHARS = 8000;
function compressToSummary(history: any[]): string {
  const topics = history
    .flatMap((h: any) => (h.metadata?.contexts_detected as string[] | undefined) || [])
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(', ');
  return topics ? `[Resumo do assunto anterior: ${topics}]` : '[Contexto anterior resumido]';
}

function isMeaningfulDiaryBlock(block: string): boolean {
  if (!block) return false;
  const lower = block.toLowerCase();
  if (lower.includes('nenhum') || lower.includes('não encontrado') || lower.includes('sem registro')) return false;
  return true;
}

async function callOpenRouterWithTimeout(
  messages: any[],
  model: string,
  temperature: number,
  timeoutMs = 9000
): Promise<string> {
  return Promise.race([
    callOpenRouter(messages, model, temperature),
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error(`OpenRouter timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2, delayMs = 1000): Promise<T | null> {
  let lastError: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < maxRetries) {
        console.warn(`Retry ${i+1}/${maxRetries} após erro:`, e);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  console.error('Falha após retries:', lastError);
  return null;
}

// ============================================================
// Query Rewriting (aumenta recall)
// ============================================================
async function rewriteQuery(userId: string, originalMessage: string, history: any[]): Promise<string> {
  const prompt = `Reescreva a mensagem do usuário para uma busca semântica eficiente, adicionando detalhes implícitos do histórico recente. 
Histórico (últimas 3 trocas): ${history.slice(-3).map((h: any) => `Usuário: ${h.content}\nAssistente: ${h.metadata?.ai_reply || ''}`).join('\n')}
Mensagem: "${originalMessage}"
Query reescrita (somente texto, sem explicação):`;
  try {
    const rewritten = await callOpenRouterWithTimeout(
      [{ role: 'system', content: prompt }],
      'google/gemini-2.0-flash-001',
      0.2,
      2000
    );
    return rewritten.trim() || originalMessage;
  } catch (e) {
    console.warn('[Rewrite] falhou, usando original');
    return originalMessage;
  }
}

// ============================================================
// FERRAMENTAS (TOOLS) – AGORA UNIFICADAS (searchWeb é a única de busca)
// ============================================================
const tools = [
  {
    type: 'function',
    function: {
      name: 'buscar_memoria_longa',
      description: 'Busca memórias de longo prazo (L3 e HD) relevantes para o contexto atual',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Termo ou pergunta para busca semântica' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'consultar_agenda',
      description: 'Obtém eventos do Google Calendar e Outlook para os próximos dias',
      parameters: {
        type: 'object',
        properties: { dias: { type: 'integer', description: 'Número de dias para frente (padrão 7)' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listar_emails_recentes',
      description: 'Busca emails recentes, opcionalmente por filtro',
      parameters: {
        type: 'object',
        properties: { filtro: { type: 'string', description: 'Termo para filtrar emails (opcional)' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'salvar_evento',
      description: 'Registra um evento (compromisso, aniversário, etc.) no banco de dados',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string' },
          data: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
          prioridade: { type: 'string', enum: ['alta', 'media', 'baixa'] },
          recorrente: { type: 'boolean', description: 'true para aniversários e eventos anuais' },
          tipo: { type: 'string', enum: ['permanent', 'recurring_annual', 'deadline', 'one_time'] }
        },
        required: ['titulo', 'data', 'prioridade', 'recorrente', 'tipo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'atualizar_meta',
      description: 'Atualiza o progresso de uma meta existente',
      parameters: {
        type: 'object',
        properties: {
          titulo_parcial: { type: 'string', description: 'Parte do título da meta' },
          progresso: { type: 'integer', minimum: 0, maximum: 100 },
          etapa_concluida: { type: 'string', description: 'Nome da etapa concluída (opcional)' }
        },
        required: ['titulo_parcial', 'progresso']
      }
    }
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
          categoria: { type: 'string', enum: ['reflexao', 'acontecimento', 'gratidao', 'qualquer'] }
        },
        required: ['texto']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'searchWeb',
      description: 'Pesquisa na internet em tempo real. Use para notícias, resultados de jogos, fatos de 2026 e informações que não estão na sua memória.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'O termo de busca preciso' } },
        required: ['query']
      }
    }
  },
  // ========== FERRAMENTAS DE CLIMA ==========
  {
    type: 'function',
    function: {
      name: 'getWeatherForecast',
      description: 'Obtém clima preciso para 5 dias. Use coordenadas de Londrina (-23.27, -51.20) para o Vista Bela se o usuário não der outras.',
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number' },
          lng: { type: 'number' }
        },
        required: ['lat', 'lng']
      }
    }
  },
  // ========== FERRAMENTAS: LUGARES E LISTAS ==========
  {
    type: 'function',
    function: {
      name: 'salvar_lugar',
      description: 'Salva um lugar favorito (mercado, farmácia, etc.) com coordenadas e raio de alerta',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome do lugar' },
          lat: { type: 'number', description: 'Latitude' },
          lng: { type: 'number', description: 'Longitude' },
          raio_metros: { type: 'integer', description: 'Raio em metros para alertas de proximidade' },
          categoria: { type: 'string', description: 'Categoria (ex: mercado, farmácia, restaurante)' }
        },
        required: ['nome', 'lat', 'lng', 'raio_metros', 'categoria']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remover_lugar',
      description: 'Remove um lugar favorito pelo nome',
      parameters: {
        type: 'object',
        properties: { nome: { type: 'string', description: 'Nome do lugar a remover' } },
        required: ['nome']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'adicionar_item_lista',
      description: 'Adiciona um item à lista de compras de um lugar específico',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'Nome do item' },
          lugar: { type: 'string', description: 'Nome do lugar (deve existir em favorite_places)' }
        },
        required: ['item', 'lugar']
      }
    }
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
          lugar: { type: 'string', description: 'Nome do lugar' }
        },
        required: ['item', 'lugar']
      }
    }
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
          lugar: { type: 'string', description: 'Nome do lugar' }
        },
        required: ['item', 'lugar']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ver_lista',
      description: 'Exibe a lista de compras de um lugar',
      parameters: {
        type: 'object',
        properties: { lugar: { type: 'string', description: 'Nome do lugar' } },
        required: ['lugar']
      }
    }
  }
];

// ============================================================
// EXECUTOR DAS FERRAMENTAS (com unificação de busca)
// ============================================================
async function executeTool(toolCall: any, userId: string, context: any): Promise<string> {
  const { name, arguments: args } = toolCall.function;
  let parsedArgs;
  try {
    parsedArgs = JSON.parse(args);
  } catch (e) {
    console.error(`[executeTool] Erro ao parsear argumentos de ${name}:`, e);
    return `Erro ao processar argumentos da ferramenta ${name}.`;
  }

  async function getPlaceId(userId: string, nomeLugar: string): Promise<string | null> {
    const { data } = await supabase
      .from('favorite_places')
      .select('id')
      .eq('user_id', userId)
      .ilike('name', nomeLugar.trim())
      .single();
    return data?.id ?? null;
  }

  switch (name) {
    case 'buscar_memoria_longa':
      const embedding = await getCachedEmbedding(parsedArgs.query);
      const { data: memories } = await supabase.rpc('match_memories', {
        query_embedding: embedding,
        match_threshold: 0.4,
        match_count: 5
      });
      return memories?.filter((m: any) => !m.summary.startsWith('[CINZA]')).map((m: any) => m.summary).join('\n---\n') || 'Nenhuma memória relevante encontrada.';

    case 'consultar_agenda':
      const [google, outlook] = await Promise.all([getGoogleContext(), getMicrosoftCalendarContext()]);
      return `Google Calendar:\n${google}\n\nOutlook:\n${outlook}`;

    case 'listar_emails_recentes':
      return await getRecentEmails(parsedArgs.filtro, 5, true);

    case 'salvar_evento':
      const eventCategory = parsedArgs.titulo.toLowerCase().includes('aniversario') ? 'family' : 'personal';
      await upsertEvent(userId, {
        title: parsedArgs.titulo,
        event_date: parsedArgs.data,
        priority: parsedArgs.prioridade,
        is_recurring: parsedArgs.recorrente,
        decay_type: parsedArgs.tipo,
        category: eventCategory,
        emotional_weight: parsedArgs.prioridade === 'alta' ? 0.9 : parsedArgs.prioridade === 'media' ? 0.6 : 0.3
      });
      return `Evento "${parsedArgs.titulo}" salvo com sucesso.`;

    case 'atualizar_meta':
      return await updateGoalProgress(userId, parsedArgs.titulo_parcial, parsedArgs.progresso, parsedArgs.etapa_concluida);

    case 'registrar_no_diario':
      await extractDiary(userId, parsedArgs.texto, parsedArgs.categoria || 'anytime');
      return `Entrada registrada no diário.`;

    // UNIFICAÇÃO: ambas as ferramentas de busca chamam a mesma implementação (Serper)
    case 'pesquisar_internet':
    case 'searchWeb':
      try {
        console.log(`[executeTool] Chamando searchWeb com query: "${parsedArgs.query}"`);
        const result = await searchWeb(parsedArgs.query);
        console.log(`[executeTool] Resultado da busca: ${result.substring(0, 200)}...`);
        return result;
      } catch (error) {
        console.error('[executeTool] Erro em searchWeb:', error);
        return `Erro na busca: ${error instanceof Error ? error.message : 'desconhecido'}`;
      }

    case 'getWeatherForecast':
      try {
        const result = await getWeatherForecast(parsedArgs.lat, parsedArgs.lng);
        return result;
      } catch (error) {
        console.error('[getWeatherForecast] Erro:', error);
        return `Erro ao obter previsão: ${error instanceof Error ? error.message : 'desconhecido'}`;
      }

    // ========== AÇÕES DE LUGARES ==========
    case 'salvar_lugar':
      const { error: placeErr } = await supabase.from('favorite_places').upsert(
        {
          user_id: userId,
          name: parsedArgs.nome.trim(),
          lat: parsedArgs.lat,
          lng: parsedArgs.lng,
          radius_meters: parsedArgs.raio_metros,
          category: parsedArgs.categoria.trim()
        },
        { onConflict: 'user_id,name' }
      );
      if (placeErr) {
        console.error('[salvar_lugar] Erro:', placeErr.message);
        return `Erro ao salvar lugar: ${placeErr.message}`;
      }
      return `Lugar "${parsedArgs.nome}" salvo com sucesso.`;

    case 'remover_lugar':
      await supabase.from('favorite_places').delete().eq('user_id', userId).ilike('name', parsedArgs.nome.trim());
      return `Lugar "${parsedArgs.nome}" removido.`;

    case 'adicionar_item_lista':
      const placeIdAdd = await getPlaceId(userId, parsedArgs.lugar);
      if (!placeIdAdd) return `Lugar "${parsedArgs.lugar}" não encontrado.`;
      await supabase.from('shopping_items').upsert(
        { user_id: userId, item: parsedArgs.item.trim(), place_id: placeIdAdd, done: false },
        { onConflict: 'user_id,item,place_id' }
      );
      return `Item "${parsedArgs.item}" adicionado à lista de ${parsedArgs.lugar}.`;

    case 'marcar_feito':
      const placeIdDone = await getPlaceId(userId, parsedArgs.lugar);
      if (!placeIdDone) return `Lugar "${parsedArgs.lugar}" não encontrado.`;
      await supabase.from('shopping_items')
        .update({ done: true })
        .eq('user_id', userId)
        .ilike('item', parsedArgs.item.trim())
        .eq('place_id', placeIdDone);
      return `Item "${parsedArgs.item}" marcado como comprado em ${parsedArgs.lugar}.`;

    case 'remover_item_lista':
      const placeIdRemove = await getPlaceId(userId, parsedArgs.lugar);
      if (!placeIdRemove) return `Lugar "${parsedArgs.lugar}" não encontrado.`;
      await supabase.from('shopping_items')
        .delete()
        .eq('user_id', userId)
        .ilike('item', parsedArgs.item.trim())
        .eq('place_id', placeIdRemove);
      return `Item "${parsedArgs.item}" removido da lista de ${parsedArgs.lugar}.`;

    case 'ver_lista':
      const placeIdList = await getPlaceId(userId, parsedArgs.lugar);
      if (!placeIdList) return `Lugar "${parsedArgs.lugar}" não encontrado.`;
      const { data: itens } = await supabase
        .from('shopping_items')
        .select('item, done')
        .eq('user_id', userId)
        .eq('place_id', placeIdList)
        .order('done');
      if (!itens || itens.length === 0) return `Lista de ${parsedArgs.lugar} está vazia.`;
      const listaTexto = itens.map((i: any) => `${i.done ? '✅' : '•'} ${i.item}`).join('\n');
      return `Lista de ${parsedArgs.lugar}:\n${listaTexto}`;

    default:
      return `Ferramenta ${name} não implementada.`;
  }
}

// ============================================================
// Chamada OpenRouter com tools
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
  tools: any[],
  model: string,
  temperature: number,
  timeoutMs = 10000
): Promise<ToolResponse> {
  const response = await Promise.race([
    fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Jarvis'
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature,
        max_tokens: 2000
      })
    }),
    new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
  ]);

  if (!response.ok) throw new Error(`OpenRouter error: ${response.status}`);
  const data = await response.json();
  const choice = data.choices?.[0];
  return { content: choice?.message?.content || '', toolCalls: choice?.message?.tool_calls || null };
}

// ============================================================
// FUNÇÕES AUXILIARES (roteamento, temperatura, plano de blocos)
// ============================================================
function routeModel(contexts: ContextType[]): { model: string; label: string } {
  const complexContexts: ContextType[] = ['agenda', 'projeto', 'familia', 'emocao', 'diario', 'meta', 'saude', 'esporte', 'noticias', 'clima'];
  const isComplex = contexts.some(c => complexContexts.includes(c));
  if (isComplex) return { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet' };
  return { model: 'google/gemini-2.0-flash-001', label: 'flash' };
}

function getTemperature(contexts: ContextType[]): number {
  if (contexts.some(c => ['emocao', 'diario'].includes(c))) return 0.9;
  if (contexts.some(c => ['casual', 'projeto', 'familia', 'meta', 'esporte'].includes(c))) return 0.7;
  if (contexts.some(c => ['rotina', 'alias', 'preferencia', 'recomendacao', 'noticias', 'clima'].includes(c))) return 0.5;
  if (contexts.some(c => ['agenda', 'evento', 'email', 'saude'].includes(c))) return 0.3;
  return 0.7;
}

function planContextualBlocks(contexts: ContextType[]): {
  loadTopics: boolean;
  loadDiary: boolean;
  loadRecommendations: boolean;
  loadCalendar: boolean;
  loadEmail: boolean;
} {
  return {
    loadTopics:          contexts.some(c => ['saude', 'projeto', 'familia', 'casual', 'rotina', 'preferencia', 'esporte', 'noticias', 'clima'].includes(c)),
    loadDiary:           contexts.some(c => ['diario', 'meta', 'emocao', 'casual'].includes(c)),
    loadRecommendations: contexts.some(c => ['recomendacao', 'casual'].includes(c)),
    loadCalendar:        contexts.some(c => ['agenda', 'evento', 'familia'].includes(c)),
    loadEmail:           contexts.some(c => ['email'].includes(c)),
  };
}

// ============================================================
// DETECTA SE A PERGUNTA EXIGE PESQUISA FORÇADA (versão melhorada)
// ============================================================
function shouldForceSearch(message: string, contexts: ContextType[]): boolean {
  const lower = message.toLowerCase();
  // Palavras que indicam necessidade de informação atualizada
  const keywords = /jogo|partida|futebol|basquete|vôlei|volei|tenis|f1|corrida|campeonato|copa|libertadores|copa do brasil|classificação|tabela|artilheiro|resultado|placar|hoje tem|quando é|próximo|escalação|expo|feira|evento|começa|início|data de|horário de|edição|notícia|últimas|recente|aconteceu|clima|tempo|temperatura|chuva|chover|previsão|cotação|preço do|valor do|dólar|euro|bitcoin|ibovespa/i;
  
  if (!keywords.test(lower)) return false;
  
  // Se já há contexto de esporte, notícias ou clima, força pesquisa
  if (contexts.includes('esporte') || contexts.includes('noticias') || contexts.includes('clima')) return true;
  
  // Se a pergunta contém "quando", "qual", "qual é", "como está", "vai", etc., provavelmente precisa de dados atuais
  if (/(quando|qual|qual é|como está|como fica|o que aconteceu|o que rolou|vai chover|vai ter|como vai ser)/i.test(lower)) return true;
  
  return false;
}

// ============================================================
// REFINA A QUERY DE BUSCA COM BASE NA MENSAGEM
// ============================================================
function refineSearchQuery(message: string, contexts: ContextType[]): string {
  let query = message;
  if (contexts.includes('esporte')) {
    const teamMatch = message.match(/(?:do|da|de|contra|entre) (.*?)(?:\?|$)/i);
    if (teamMatch && teamMatch[1].trim().length < 30) {
      query = `${teamMatch[1].trim()} ${message.includes('escalação') ? 'escalação' : 'próximo jogo'} 2026`;
    } else {
      query = `${message} 2026`;
    }
  }
  if (contexts.includes('evento') && /expo|feira|evento|começa|início/i.test(message)) {
    const currentYear = new Date().getFullYear();
    query = `${message} ${currentYear}`;
  }
  if (contexts.includes('clima')) {
    const locationMatch = message.match(/(em|no|na) (.*?)(?:\?|$)/i);
    if (locationMatch && locationMatch[2].trim().length < 30) {
      query = `clima ${locationMatch[2].trim()}`;
    } else {
      query = `clima ${message}`;
    }
  }
  if (contexts.includes('noticias') && !/(notícia|notícias)/i.test(query)) {
    query = `últimas notícias ${query}`;
  }
  return query.trim();
}

// ============================================================
// WEBHOOK PRINCIPAL
// ============================================================
export async function POST(req: NextRequest) {
  try {
    console.time('[Performance] total');
    // ----------------------------------------------------------
    // 1. Parse da requisição (JSON ou FormData com áudio)
    // ----------------------------------------------------------
    let messageText: string;
    let userId: string;
    let userFirstName = "Usuário";
    let location: { latitude: number; longitude: number } | null = null;

    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const audioFile = formData.get('audio') as File | null;
      const userIdField = formData.get('userId') as string | null;
      const userFirstNameField = formData.get('userFirstName') as string | null;

      const latField = formData.get('latitude') as string | null;
      const lngField = formData.get('longitude') as string | null;
      if (latField && lngField) {
        location = { latitude: parseFloat(latField), longitude: parseFloat(lngField) };
      }

      if (!audioFile || !userIdField) {
        return NextResponse.json({ error: 'Campos obrigatórios: audio, userId' }, { status: 400 });
      }

      userId = userIdField;
      if (userFirstNameField) userFirstName = userFirstNameField;

      const buffer = Buffer.from(await audioFile.arrayBuffer());
      const whisperFormData = new FormData();
      whisperFormData.append('file', new Blob([buffer]), 'audio.ogg');
      whisperFormData.append('model', 'whisper-1');
      whisperFormData.append('language', 'pt');

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: whisperFormData
      });

      if (!whisperRes.ok) {
        return NextResponse.json({ error: 'Falha na transcrição' }, { status: 500 });
      }

      const whisperData = await whisperRes.json();
      messageText = whisperData.text?.trim() || '';
      if (!messageText) {
        return NextResponse.json({ error: 'Áudio vazio ou ininteligível' }, { status: 400 });
      }
    } else {
      const body = await req.json();
      messageText = body.message || body.text || '';
      userId = body.userId || body.user_id;
      userFirstName = body.userFirstName || body.user_first_name || 'Usuário';
      if (body.location && typeof body.location.latitude === 'number' && typeof body.location.longitude === 'number') {
        location = { latitude: body.location.latitude, longitude: body.location.longitude };
      }
    }

    if (!messageText || !userId) {
      return NextResponse.json({ error: 'Mensagem ou userId ausente' }, { status: 400 });
    }

    // ----------------------------------------------------------
    // 2. Dados essenciais do usuário
    // ----------------------------------------------------------
    const userResult = await supabase
      .from('users')
      .select('nickname, current_context, pending_question, pending_context, plan, assistant_name, timezone')
      .eq('id', userId).single();
    const userProfile = userResult.data;
    const authorName = userProfile?.nickname || userFirstName;
    const assistantName = userProfile?.assistant_name || 'Lev';
    const userTimezone = userProfile?.timezone || 'America/Sao_Paulo';
    const currentContextL3 = userProfile?.current_context || "Sem dossiê ainda.";
    const pendingQuestion = userProfile?.pending_question || null;

    ensureMemoryHealth(userId).catch(e => console.error('[Health] Erro em background:', e));

    // ----------------------------------------------------------
    // 3. Processamento de localização (se enviada)
    // ----------------------------------------------------------
    let locationContext = "";
    let geoAlert = null;

    if (location) {
      const { latitude, longitude } = location;
      const endereco = await checkProximidade(latitude, longitude);
      locationContext = `${endereco}\nCoordenadas exatas: ${latitude}, ${longitude}`;
      await supabase.from('config').upsert(
        { key: `last_location_${userId}`, value: JSON.stringify({ latitude, longitude, endereco, ts: Date.now() }) },
        { onConflict: 'key' }
      );
      const alertaGeo = await verificarAlertasDeProximidade(userId, latitude, longitude);
      if (alertaGeo.temAlerta) {
        geoAlert = alertaGeo.mensagem;
        return NextResponse.json({ reply: geoAlert, ok: true });
      }
      if (!messageText) messageText = "[Enviou Localização]";
    } else {
      const { data: lastLoc } = await supabase
        .from('config').select('value')
        .eq('key', `last_location_${userId}`).single();
      if (lastLoc?.value) {
        try {
          const loc = JSON.parse(lastLoc.value);
          const idadeMinutos = (Date.now() - loc.ts) / 60000;
          if (idadeMinutos <= 60) {
            locationContext = `${loc.endereco}\nCoordenadas exatas: ${loc.latitude}, ${loc.longitude} (compartilhada há ${Math.round(idadeMinutos)} min)`;
          }
        } catch { /* ignore */ }
      }
    }

    // ----------------------------------------------------------
    // 4. Classificação de contexto, tópicos L4 e roteamento
    // ----------------------------------------------------------
    console.time('[Performance] context_classification');
    const detectedContexts = await classifyContextWithL4(messageText, userId);
    console.timeEnd('[Performance] context_classification');
    
    await updateTopicIndex(userId, detectedContexts, messageText);
    const relatedTopicsBlock = await getRelatedTopics(userId, detectedContexts[0] || 'casual');

    const modelRoute = routeModel(detectedContexts);
    const temperature = getTemperature(detectedContexts);
    const blockPlan = planContextualBlocks(detectedContexts);

    console.log(`[Sprint1] contextos: ${detectedContexts.join(',')} | modelo: ${modelRoute.label} | temp: ${temperature}`);

    // ----------------------------------------------------------
    // 5. PESQUISA FORÇADA (se necessário) – agora usando searchWeb
    // ----------------------------------------------------------
    let forcedSearchResult = "";
    const shouldForce = shouldForceSearch(messageText, detectedContexts);
    console.log(`[ForcedSearch] shouldForceSearch = ${shouldForce}`);
    if (shouldForce) {
      const searchQuery = refineSearchQuery(messageText, detectedContexts);
      console.log(`[ForcedSearch] Executando pesquisa para: ${searchQuery}`);
      try {
        // Simula uma chamada de ferramenta searchWeb
        const toolCall = {
          function: {
            name: 'searchWeb',
            arguments: JSON.stringify({ query: searchQuery })
          }
        };
        const result = await executeTool(toolCall, userId, {});
        forcedSearchResult = `\n[PESQUISA AUTOMÁTICA REALIZADA]\nConsulta: "${searchQuery}"\nResultado:\n${result}`;
        console.log(`[ForcedSearch] Resultado obtido (primeiros 200 chars): ${result.substring(0, 200)}`);
      } catch (e) {
        console.error("[ForcedSearch] Falha:", e);
        forcedSearchResult = "\n[ERRO NA PESQUISA] Não foi possível obter informações atualizadas.";
      }
    }

    // ----------------------------------------------------------
    // 6. Busca de dados de contexto
    // ----------------------------------------------------------
    const basePromises = Promise.all([
      supabase
        .from('users')
        .select('nickname, current_context, pending_question, pending_context, plan, assistant_name, timezone')
        .eq('id', userId).single(),
      getOrCreateSession(userId),
      supabase
        .from('events')
        .select('title, event_date, category, decay_type, relevance_score, emotional_weight, is_recurring, notes')
        .eq('user_id', userId).order('relevance_score', { ascending: false }),
      supabase
        .from('memory_ashes')
        .select('ash_summary, period_start, period_end')
        .eq('user_id', userId).order('period_end', { ascending: false }).limit(5),
      supabase
        .from('onboarding_progress')
        .select('*').eq('user_id', userId).single(),
      buildGapsBlock(userId, messageText),
      supabase
        .from('principles')
        .select('content, category').order('created_at', { ascending: true }),
    ]);

    const conditionalTasks: Promise<any>[] = [];
    if (blockPlan.loadCalendar) {
      conditionalTasks.push(getGoogleContext());
      conditionalTasks.push(getMicrosoftCalendarContext());
    }
    if (blockPlan.loadEmail) {
      conditionalTasks.push(getRecentEmails(undefined, 3, false));
    }
    if (blockPlan.loadTopics) {
      conditionalTasks.push(buildTopicBlock(userId, messageText));
    }
    if (blockPlan.loadDiary) {
      conditionalTasks.push(buildDiaryGoalsBlock(userId));
    }
    
    const [
      [
        userProfileResult,
        sessionId,
        eventsResult,
        ashesResult,
        onboardingResult,
        gapsBlock,
        principlesResult,
      ],
      conditionalResults
    ] = await Promise.all([basePromises, Promise.all(conditionalTasks)]);
    
    let googleContextBlock = null, microsoftContextBlock = null, emailRadarBlock = null;
    let topicBlock = '', diaryGoalsBlock = '';
    let resultIndex = 0;
    if (blockPlan.loadCalendar) {
      googleContextBlock = conditionalResults[resultIndex++];
      microsoftContextBlock = conditionalResults[resultIndex++];
    }
    if (blockPlan.loadEmail) {
      emailRadarBlock = conditionalResults[resultIndex++];
    }
    if (blockPlan.loadTopics) {
      topicBlock = conditionalResults[resultIndex++] || '';
    }
    if (blockPlan.loadDiary) {
      diaryGoalsBlock = conditionalResults[resultIndex++] || '';
    }
    
    const recommendationsBlock = blockPlan.loadRecommendations
      ? await buildRecommendationsBlock(userId, messageText)
      : '';

    const isGoogleError = typeof googleContextBlock === 'string' && googleContextBlock.includes('Erro');
    const isMicrosoftError = typeof microsoftContextBlock === 'string' && microsoftContextBlock.includes('Erro');
    const isEmailError = typeof emailRadarBlock === 'string' && emailRadarBlock?.includes('Erro');
    const cleanGoogleContext = isGoogleError ? null : googleContextBlock;
    const cleanMicrosoftContext = isMicrosoftError ? null : microsoftContextBlock;
    const cleanEmailRadarBlock = isEmailError ? null : emailRadarBlock;

    const principles = principlesResult?.data || [];
    const principlesBlock = principles.length > 0
      ? principles.map((p: any) => `- ${p.content}`).join('\n')
      : '';

    const isFemale = currentContextL3.toLowerCase().includes('feminino') ||
                     currentContextL3.toLowerCase().includes('mulher');
    const informalAddress = isFemale ? 'miga' : 'cara';

    let onboardingState = onboardingResult?.data || null;
    if (!onboardingState) onboardingState = await getOrCreateOnboardingStatePersistent(userId);
    const onboardingBlock = buildOnboardingBlock(onboardingState);

    // Eventos
    const events = eventsResult.data || [];
    const hoje = new Date();
    hoje.setHours(0,0,0,0);
    const sortedEvents = [...events].sort((a,b) => {
      const da = new Date(a.event_date).getTime();
      const db = new Date(b.event_date).getTime();
      return Math.abs(da - hoje.getTime()) - Math.abs(db - hoje.getTime());
    });
    const upcomingEvents = sortedEvents.filter(e => {
      const evDate = new Date(e.event_date);
      const diffDays = Math.ceil((evDate.getTime() - hoje.getTime()) / (1000*3600*24));
      return diffDays >= 0 && diffDays <= 7;
    });
    const highRelevanceEvents = sortedEvents.filter(e => (e.relevance_score || 0) >= 0.7 && !upcomingEvents.includes(e));
    const activeEvents = sortedEvents.filter(e => {
      const evDate = new Date(e.event_date);
      return evDate >= hoje || (e.decay_type === 'permanent' && evDate < hoje);
    });
    const eventsBlock = activeEvents.length > 0 ? [
      upcomingEvents.length > 0
        ? `🔴 NOS PRÓXIMOS DIAS:\n${upcomingEvents.map(e => `  - ${e.title}: ${e.event_date}${e.notes ? ` (${e.notes})` : ''}`).join('\n')}`
        : null,
      highRelevanceEvents.length > 0
        ? `🟡 IMPORTANTES:\n${highRelevanceEvents.map(e => `  - ${e.title}: ${e.event_date}`).join('\n')}`
        : null,
    ].filter(Boolean).join('\n\n') : "Nenhum evento cadastrado.";

    const ashes = ashesResult.data || [];
    const ashesBlock = ashes.length > 0 ? ashes.map((a: any) => a.ash_summary).join('\n') : null;

    // Notas contextuais
    let personNotesBlock = "";
    const [childrenResult, personNotesResult] = await Promise.all([
      supabase.from('children').select('name, nickname, lev_notes')
        .eq('parent_id', userId).not('lev_notes', 'is', null),
      supabase.from('person_notes').select('person_name, person_type, note, noted_at')
        .eq('user_id', userId).order('noted_at', { ascending: false }).limit(20),
    ]);
    const msgLower = messageText.toLowerCase();
    const childNotes = (childrenResult.data || []).filter((c: any) => {
      const nick = (c.nickname || '').toLowerCase();
      const name = (c.name || '').split(' ')[0].toLowerCase();
      return msgLower.includes(nick) || msgLower.includes(name);
    });
    const pNotes = (personNotesResult.data || []).filter((n: any) => {
      const parts = n.person_name.toLowerCase().split(' ');
      return parts.some((p: string) => p.length >= 3 && new RegExp(`\\b${p}\\b`).test(msgLower));
    });
    if (childNotes.length > 0 || pNotes.length > 0) {
      const lines: string[] = [];
      for (const c of childNotes) lines.push(`${c.nickname || c.name.split(' ')[0]}: ${c.lev_notes}`);
      for (const n of pNotes) lines.push(`${n.person_name} [${n.noted_at}]: ${n.note}`);
      personNotesBlock = `[NOTAS SOBRE PESSOAS MENCIONADAS]\n${lines.join('\n')}`;
    }

    // HD vetorial
    const queryEmbedding = await getCachedEmbedding(messageText);
    let hdBlock = "";
    let hdMemoryIds: string[] = [];
    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', {
        query_embedding: queryEmbedding,
        match_threshold: 0.4,
        match_count: 3
      }) as { data: any[] | null };
      if (search && search.length > 0) {
        hdBlock = search.filter((r: any) => !r.summary.startsWith('[CINZA]')).map((r: any) => r.summary).join('\n---\n');
        hdMemoryIds = search.map((r: any) => r.id);
      }
    }

    // RAM comprimida
    let ramBlock = "";
    const { data: historySession } = await supabase
      .from('brain').select('content, metadata')
      .eq('user_id', userId).eq('session_id', sessionId)
      .neq('category', 'archived').order('created_at', { ascending: false }).limit(10);
    const topicShifted = await detectTopicShiftWithL4(userId, detectedContexts);
    if (historySession && historySession.length >= 2) {
      if (topicShifted) {
        const summary = compressToSummary(historySession.slice(3));
        const recentRaw = [...historySession].slice(0, 3).reverse().map((h: any) => {
          const ai = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
          return `${authorName}: ${h.content}\n${assistantName}: ${ai}`;
        }).join('\n\n');
        ramBlock = `${summary}\n\n${recentRaw}`;
      } else {
        ramBlock = [...historySession].reverse().map((h: any) => {
          const ai = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
          return `${authorName}: ${h.content}\n${assistantName}: ${ai}`;
        }).join('\n\n');
      }
    } else {
      const semanticBlock = await semanticRamCompression(historySession || [], userId, messageText, queryEmbedding);
      if (semanticBlock) ramBlock = semanticBlock;
      else if (hdBlock) ramBlock = `[Contexto anterior consolidado]\n${hdBlock}`;
    }
    if (ramBlock.length > RAM_MAX_CHARS) ramBlock = ramBlock.slice(-RAM_MAX_CHARS);

    // Classificador temporal
    const weights = classifyTemporalHorizon(messageText, ramBlock, pendingQuestion);
    const truncatedL3 = truncateByWeight(currentContextL3, weights.l3, 6000);
    const truncatedHd = truncateByWeight(hdBlock, weights.hd, 6000);
    const truncatedAshes = ashesBlock ? truncateByWeight(ashesBlock, weights.ashes, 6000) : null;
    const truncatedEvents = truncateByWeight(eventsBlock, weights.events, 6000);
    const fusoHorario = new Date().toLocaleString('pt-BR', { timeZone: userTimezone });

    // ----------------------------------------------------------
    // 7. System prompt – VERSÃO REFORÇADA (com pesquisa automática)
    // ----------------------------------------------------------
    const systemPrompt = `
Você é ${assistantName}, assistente pessoal de ${authorName}.
Data/hora: ${fusoHorario} | Modo: ${weights.horizon.toUpperCase()}

🚨 **REGRRA ABSOLUTA – PESQUISE SEMPRE!** 🚨

Para QUALQUER pergunta sobre:
- Jogos, partidas, resultados esportivos (futebol, basquete, F1, etc.)
- Datas e horários de eventos futuros (exposições, shows, estreias)
- Notícias recentes, cotações, clima em outras cidades
- Escalações de times, tabelas de campeonatos
- Qualquer informação que possa ter mudado desde ontem

**VOCÊ DEVE** chamar a ferramenta \`searchWeb\` ANTES de responder.

**ATENÇÃO:** Se o bloco "[PESQUISA AUTOMÁTICA REALIZADA]" estiver presente no contexto, você DEVE usá-lo como fonte principal e NÃO inventar informações. Se o bloco indicar erro, diga que não foi possível obter dados atualizados.

${forcedSearchResult}

${cleanGoogleContext    ? `[AGENDA GOOGLE ATUALIZADA]\n${cleanGoogleContext}`      : ''}
${cleanMicrosoftContext ? `[AGENDA OUTLOOK ATUALIZADA]\n${cleanMicrosoftContext}`  : ''}
${cleanEmailRadarBlock  ? `[RADAR DE EMAILS RELEVANTES]\n${cleanEmailRadarBlock}`  : ''}
${locationContext       ? `\n${locationContext}`                                    : ''}
${relatedTopicsBlock    ? relatedTopicsBlock                                        : ''}

${truncatedL3 ? `[QUEM É ${authorName.toUpperCase()}]\n${truncatedL3}` : ''}

${personNotesBlock     ? personNotesBlock     : ''}
${recommendationsBlock ? recommendationsBlock : ''}
${topicBlock           ? topicBlock           : ''}
${isMeaningfulDiaryBlock(diaryGoalsBlock) ? diaryGoalsBlock : ''}

${truncatedHd ? `[MEMÓRIAS DE LONGO PRAZO]\n${truncatedHd}` : ''}

${truncatedAshes ? `[MEMÓRIAS DISTANTES — use "lembro vagamente que..." ao citar]\n${truncatedAshes}` : ''}

${onboardingBlock}
${gapsBlock}

${principlesBlock ? `[BÚSSOLA — seu jeito de ser no mundo, não regras a citar]\n${principlesBlock}` : ''}

Você tem ferramentas nativas: \`buscar_memoria_longa\`, \`consultar_agenda\`, \`listar_emails_recentes\`, \`salvar_evento\`, \`atualizar_meta\`, \`registrar_no_diario\`, \`searchWeb\`, \`getWeatherForecast\`, e as de lugares/listas.

REGRAS COMPORTAMENTAIS:
1. FOCO: Responda O QUE FOI PERGUNTADO. Nunca mude de assunto.
   - Pronomes ("esse filme", "isso", "ele") sempre se referem ao ÚLTIMO assunto.
   - NUNCA repita sugestão rejeitada.

2. TOM: Amigo inteligente, direto, humano.
   - Use "${informalAddress}" no máximo 1x por conversa.
   - NUNCA comece com "Considerando que" / "Levando em conta seu perfil".
   - PROIBIDO: "Anotado!", "Registrado!", "Guardei aqui!". Se salvou algo via ferramenta, diga naturalmente: "Feito.", "Tá na agenda."

3. PRESENÇA EMOCIONAL: Quando ${authorName} compartilhar algo difícil, seja empático – não aja como sistema de registros.

4. MEMÓRIA: Use notas e memórias naturalmente. Nunca diga "Tenho uma nota aqui que diz...".

5. FAMÍLIA: Nunca assuma que mãe/pai de um filho é o cônjuge atual.

6. LOCALIZAÇÃO: Se disponível, use para contextualizar – não cite coordenadas.

7. EVENTOS: Prioridade máxima a eventos nos próximos 7 dias.

8. CLASSIFICAÇÃO: Ao final da sua resposta, inclua obrigatoriamente [CLASSE: info] ou [CLASSE: noise].
`.trim();

    // ----------------------------------------------------------
    // 8. Montagem das mensagens (histórico intercalado)
    // ----------------------------------------------------------
    const { data: historyForMessages } = await supabase
      .from('brain').select('content, metadata')
      .eq('user_id', userId).neq('category', 'archived')
      .order('created_at', { ascending: false }).limit(10);

    const conversationMessages: any[] = [
      { role: 'system', content: systemPrompt },
      ...(historyForMessages || []).reverse().flatMap((h: any) => [
        { role: 'user', content: h.content },
        { role: 'assistant', content: (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim() }
      ]),
      { role: 'user', content: messageText }
    ];

    // ----------------------------------------------------------
    // 9. Comandos especiais (ignorar, apagar)
    // ----------------------------------------------------------
    const ignorePatterns = /ignore isso|ignora isso|não salva|nao salva|apaga isso|esquece isso|esquece|delete isso/i;
    if (ignorePatterns.test(messageText)) {
      const { data: lastEntry } = await supabase
        .from('brain').select('id').eq('user_id', userId)
        .order('created_at', { ascending: false }).limit(1).single();
      if (lastEntry) await supabase.from('brain').delete().eq('id', lastEntry.id);
      return NextResponse.json({ reply: 'Feito — apaguei o que foi dito antes. 🗑️', ok: true });
    }

    // ----------------------------------------------------------
    // 10. Pré‑extração e feedback interno
    // ----------------------------------------------------------
    const noisePatterns = /^(ok|oi|olá|ola|bom dia|boa tarde|boa noite|tudo bem|tudo bom|blz|vlw|valeu|obrigad|kkk|haha|rs|👍|🙏|😂|!)[\s!?.]*$/i;
    const isLikelyNoise = noisePatterns.test(messageText.trim()) && messageText.length < 30;

    let extractionSummary = '';
    if (!isLikelyNoise) {
      try {
        extractionSummary = await extractAndSummarize(userId, authorName, messageText);
      } catch (e) {
        console.error('[Extrator/pre] Erro:', e);
      }
    }

    const feedbackContent = extractionSummary
      ? `[INTERNO]\nRegistrado: ${extractionSummary}\nConfirme em 1 frase curta. Ex: "Dia 13 de dezembro, certo." / "Guardei o aniversário de casamento."\nPROIBIDO: "Anota aí", "Anotado!", "Registrado!" — nunca.`
      : `[INTERNO]\nVocê é o assistente — NUNCA diga "Anota aí" ou peça ao usuário para anotar algo.\nSe o usuário informar uma data ou fato, confirme brevemente ou responda naturalmente.`;
    conversationMessages.push({ role: 'system', content: feedbackContent });

    // ----------------------------------------------------------
    // 11. Loop ReAct com ferramentas
    // ----------------------------------------------------------
    let finalResponse = '';
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      const response = await callOpenRouterWithTools(
        conversationMessages,
        tools,
        modelRoute.model,
        temperature,
        12000
      );
      const { content, toolCalls } = response;

      if (!toolCalls || toolCalls.length === 0) {
        finalResponse = content;
        break;
      }

      conversationMessages.push({
        role: 'assistant',
        content: null,
        tool_calls: toolCalls
      });

      for (const toolCall of toolCalls) {
        const result = await executeTool(toolCall, userId, { authorName, assistantName });
        conversationMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result
        });
      }

      attempts++;
    }

    if (attempts >= maxAttempts) {
      finalResponse = "Ops, tive que encerrar após muitas tentativas. Pode repetir?";
    }

    // ----------------------------------------------------------
    // 12. Pós‑processamento (categoria, remoção de tags)
    // ----------------------------------------------------------
    let category = 'info';
    const categoryMatch = finalResponse.match(/\[CLASSE:\s*(\w+)\]/i);
    if (categoryMatch) category = categoryMatch[1].toLowerCase();
    finalResponse = finalResponse.replace(/\[CLASSE:\s*\w+\]/gi, '').trim();

    if (!finalResponse && extractionSummary) {
      const feedbacks = ['Certo.', 'Ok.', 'Guardei.', 'Entendido.'];
      finalResponse = feedbacks[Math.floor(Math.random() * feedbacks.length)];
    }

    // ----------------------------------------------------------
    // 13. Persistência no banco
    // ----------------------------------------------------------
    const { error: insertError } = await supabase.from('brain').insert([{
      content: messageText,
      category,
      user_id: userId,
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
        forced_search_used: forcedSearchResult ? true : false,
      }
    }]);

    if (insertError) console.error('BRAIN INSERT ERRO:', insertError);
    else console.log('BRAIN INSERT OK — user:', userId, 'session:', sessionId, 'model:', modelRoute.label);

    for (const memId of hdMemoryIds) await reinforceMemory(memId);

    // ----------------------------------------------------------
    // 14. Tarefas em background (extração, compactação)
    // ----------------------------------------------------------
    const backgroundTasks: Promise<any>[] = [];

    if (onboardingState?.status === 'in_progress') {
      backgroundTasks.push(
        withRetry(() => processOnboardingFromMessage(userId, messageText, finalResponse, onboardingState))
          .catch(e => console.error('[Onboarding] Erro após retries:', e))
      );
    }

    if (!isLikelyNoise) {
      backgroundTasks.push(
        withRetry(() => extractRecomendacao(userId, messageText, finalResponse))
          .catch(e => console.error('[Extrator/recomendacao] Erro:', e))
      );
      backgroundTasks.push(
        withRetry(() => extractDiary(userId, messageText, 'anytime'))
          .catch(e => console.error('[diary] Erro:', e))
      );
      backgroundTasks.push(
        withRetry(() => extractGoal(userId, messageText))
          .catch(e => console.error('[goals] Erro:', e))
      );
    }

    Promise.all([
      ...backgroundTasks,
      supabase
        .from('brain').select('*', { count: 'exact', head: true })
        .eq('user_id', userId).eq('category', 'info')
        .then(({ count }) => {
          if (count && count >= 20) return compactMemory(userId, authorName);
        }),
    ]).catch(e => console.error('[Background] Erro geral:', e));

    console.timeEnd('[Performance] total');
    // ----------------------------------------------------------
    // 15. Retorno para o app
    // ----------------------------------------------------------
    return NextResponse.json({ reply: finalResponse, ok: true });

  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
