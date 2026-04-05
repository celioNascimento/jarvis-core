// app/api/chat/route.ts
// Motor V8 Unificado — Arquitetura Dual-ID
// ✅ CORREÇÕES: threshold 0.10 (compatibilidade OpenRouter embeddings), logs de score
// ✅ TRANSCRIÇÃO: usa lib/services/transcription.ts com OPENAI_API_KEY_1
// ✅ EMOTIONAL ROUTER: integrado com ordenação correta e cache
// ✅ FIX [v8.1]: Anti-sycophancy — modelo não pode confirmar dado externo sem nova busca
// ✅ FIX [v8.1]: Data/hora injetada no prompt com fuso correto + instrução de validação temporal
// ✅ FIX [v8.2]: Sanitização de saída — remove [INTERNO:], [DEBUG:], [ERROR:] e dados sensíveis
// ✅ FIX [v8.3]: Fallback universal para resposta vazia após sanitização
// ✅ FIX [v8.4]: Cache em memória com TTL para chamadas repetitivas (Supabase, Google, Microsoft, L4, blocos)
// ✅ FIX [v8.5]: Correção de tipos TypeScript (ContextType[], principlesBlock -> principles)
// ✅ FIX [v8.6]: Adicionado bloco de feriados nacionais próximos no system prompt

import { NextRequest, NextResponse } from 'next/server';
import {
  supabase,
  compactMemory,
  getOrCreateSession,
  reinforceMemory,
  clearPendingQuestion,
} from '@/lib/jarvis';
import { getRecentEmails, getMicrosoftCalendarContext } from '@/lib/microsoft';
import { getGoogleContext, searchWeb } from '@/lib/google';
import { checkProximidade } from '@/lib/geo';
import { verificarAlertasDeProximidade } from '@/lib/geo-alerts';
import { classifyTemporalHorizon, truncateByWeight } from '@/lib/context-router';
import {
  initOnboarding,
  processOnboardingFromMessage,
  buildOnboardingBlock,
} from '@/lib/onboarding';
import { extractAndSummarize, buildGapsBlock } from '@/lib/extractor';
import {
  buildRecommendationsBlock,
  buildTopicBlock,
  extractRecomendacao,
} from '@/lib/extractor-jobs';
import { extractDiary, extractGoal, buildDiaryGoalsBlock } from '@/lib/diary';
import { assertNumericUserId } from '@/lib/chat/guards';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import { ensureMemoryHealth } from '@/lib/chat/event-relevance';
import {
  classifyContextWithL4,
  routeModel,
  getTemperature,
  planContextualBlocks,
  classifyContextRegex,
  type ContextType,
} from '@/lib/chat/context-classifier';
import { shouldForceSearch, refineSearchQuery } from '@/lib/chat/search-router';
import {
  updateTopicIndex,
  getRelatedTopics,
  detectTopicShiftWithL4,
} from '@/lib/chat/topic-index';
import {
  RAM_MAX_CHARS,
  compressToSummary,
  semanticRamCompression,
  isMeaningfulDiaryBlock,
} from '@/lib/chat/ram';
import { tools } from '@/lib/chat/tools-def';
import { executeTool } from '@/lib/chat/tools-executor';
import { callOpenRouterWithTools, withRetry } from '@/lib/chat/openrouter';
import { transcribeAudio, extractAudioBuffer } from '@/lib/services/transcription';
import { computeEmotionalScore } from '@/lib/chat/emotional-router';
import { getUpcomingHolidays } from '@/lib/holidays';

export const maxDuration = 60;

// ===================== [FIX v8.4] CACHE EM MEMÓRIA COM TTL =====================
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class MemoryCache {
  private store = new Map<string, CacheEntry<any>>();
  private defaultTTL = 30000; // 30 segundos

  set<T>(key: string, value: T, ttlMs?: number): void {
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTTL);
    this.store.set(key, { value, expiresAt });
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  clear(): void {
    this.store.clear();
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }
}

const cache = new MemoryCache();
// Limpeza automática a cada 1 minuto (evita vazamento de memória)
setInterval(() => cache.cleanup(), 60000);
// ====================================================================

// ---------------------------------------------------------------------------
// [FIX v8.2] Função para sanitizar dados sensíveis na resposta
// ---------------------------------------------------------------------------
function sanitizeSensitiveData(text: string): string {
  if (!text) return text;
  
  const patterns = [
    /(sk-[A-Za-z0-9_\-]{20,})/gi,
    /(Bearer\s+[A-Za-z0-9_\-\.]{20,})/gi,
    /(Authorization:\s*['"]?[A-Za-z0-9_\-]+)/gi,
    /(api[_-]?key['"]?\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,})/gi,
    /(password['"]?\s*[:=]\s*['"]?[^'"\s]{4,})/gi,
    /(secret['"]?\s*[:=]\s*['"]?[^'"\s]{4,})/gi,
    /(token['"]?\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,})/gi,
    /(x-api-key['"]?\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,})/gi,
  ];
  
  let sanitized = text;
  for (const pattern of patterns) {
    sanitized = sanitized.replace(pattern, (match) => {
      if (match.includes('=')) return match.replace(/=.*/, '= [REDACTED]');
      if (match.includes(':')) return match.replace(/:.*/, ': [REDACTED]');
      return '[REDACTED]';
    });
  }
  return sanitized;
}
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// [FIX v8.1] Helpers de data/hora com fuso
// ---------------------------------------------------------------------------
function buildDateTimeBlock(timezone: string): string {
  const now = new Date();
  const locale = 'pt-BR';
  const dateStr = now.toLocaleDateString(locale, {
    timeZone: timezone,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const timeStr = now.toLocaleTimeString(locale, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${dateStr} às ${timeStr} (${timezone})`;
}

function getCurrentDateParts(timezone: string): { day: number; month: number; year: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  }).formatToParts(now);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  return { day: get('day'), month: get('month'), year: get('year') };
}
// ---------------------------------------------------------------------------

async function getOrCreateOnboardingStatePersistent(userId: string) {
  const { data: onboardingMemory } = await supabase
    .from('memories')
    .select('metadata')
    .eq('user_id', userId)
    .eq('category', 'onboarding')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (onboardingMemory?.metadata?.state) return onboardingMemory.metadata.state;
  return await initOnboarding(userId);
}

export async function POST(req: NextRequest) {
  console.log('[chat] Iniciando — V8 Dual-ID refatorado');
  try {
    console.time('[Performance] total');
    let messageText = '';
    let userEmail = '';
    let tempUserId = '';
    let clientSessionId: string | null = null;
    let userFirstName = 'Usuário';
    let location: { latitude: number; longitude: number } | null = null;

    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const audioFile = formData.get('audio') as File | null;

      userEmail = (formData.get('userEmail') as string) || (formData.get('email') as string) || '';
      tempUserId = (formData.get('userId') as string) || (formData.get('user_id') as string) || '';
      clientSessionId = formData.get('sessionId') as string | null;
      userFirstName = (formData.get('userFirstName') as string) || 'Usuário';

      const latField = formData.get('latitude') as string | null;
      const lngField = formData.get('longitude') as string | null;
      if (latField && lngField)
        location = { latitude: parseFloat(latField), longitude: parseFloat(lngField) };

      if (!audioFile && !formData.get('message') && !formData.get('text')) {
        return NextResponse.json({ error: 'Áudio ou texto obrigatório' }, { status: 400 });
      }

      if (audioFile) {
        console.time('[Transcription] whisper');
        const buffer = await extractAudioBuffer(audioFile);
        const result = await transcribeAudio(buffer, { language: 'pt' });
        console.timeEnd('[Transcription] whisper');

        if (!result.success) {
          console.error('[Chat] Transcrição falhou:', result.error);
          return NextResponse.json(
            { error: result.error || 'Falha na transcrição' },
            { status: result.error?.includes('Autenticação') ? 401 : 500 }
          );
        }

        messageText = result.text || '';
        console.log('[Chat] Transcrição concluída:', messageText.substring(0, 100) + (messageText.length > 100 ? '...' : ''));
      } else {
        messageText = (formData.get('message') as string) || (formData.get('text') as string) || '';
      }
    } else {
      const body = await req.json();
      messageText = body.message || body.text || '';
      userEmail = body.userEmail || body.email || '';
      tempUserId = body.userId || body.user_id || '';
      clientSessionId = body.sessionId || null;
      userFirstName = body.userFirstName || body.user_first_name || 'Usuário';

      if (body.location?.latitude != null && body.location?.longitude != null) {
        location = { latitude: body.location.latitude, longitude: body.location.longitude };
      }
    }

    if (!messageText && !location)
      return NextResponse.json({ error: 'message obrigatório' }, { status: 400 });
    if (!userEmail && !tempUserId)
      return NextResponse.json({ error: 'userEmail ou userId obrigatório' }, { status: 400 });

    // Lookup do usuário
    let userRecord: any = null;

    if (userEmail) {
      console.log('[chat] Buscando usuário por email:', userEmail);
      const { data, error } = await supabase
        .from('users')
        .select('id, nickname, current_context, assistant_name, timezone, pending_question, pending_context, auth_user_id')
        .eq('email', userEmail)
        .maybeSingle();

      if (error) console.error('[chat] Erro na busca por email:', error);
      if (data) console.log('[chat] Usuário encontrado por email, id:', data.id);
      userRecord = data;
    }

    if (!userRecord && tempUserId) {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tempUserId);

      if (isUUID) {
        console.log('[chat] Buscando usuário por auth_user_id (UUID):', tempUserId);
        const { data, error } = await supabase
          .from('users')
          .select('id, nickname, current_context, assistant_name, timezone, pending_question, pending_context, auth_user_id')
          .eq('auth_user_id', tempUserId)
          .maybeSingle();

        if (error) console.error('[chat] Erro na busca por auth_user_id:', error);
        if (data) console.log('[chat] Usuário encontrado por UUID, id:', data.id);
        userRecord = data;
      } else {
        console.warn('[chat] tempUserId não é UUID válido:', tempUserId);
      }
    }

    if (!userRecord) {
      console.error('[chat] USUÁRIO NÃO ENCONTRADO! email:', userEmail, 'userId:', tempUserId);
      return NextResponse.json({
        error: 'Usuário não encontrado. Faça login novamente.',
        debug: { email: userEmail, userId: tempUserId }
      }, { status: 404 });
    }

    // DUAL-ID
    const numericUserIdStr = String(userRecord.id);
    assertNumericUserId(numericUserIdStr, 'POST /api/chat');

    let authUserId: string | null = userRecord.auth_user_id || null;

    if (!authUserId && tempUserId) {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tempUserId);
      if (isUUID) {
        authUserId = tempUserId;
        console.log('[chat] authUserId via tempUserId UUID:', authUserId);
      }
    }

    if (!authUserId) {
      console.warn('[chat] authUserId não resolvido — operações de Auth podem falhar');
      authUserId = numericUserIdStr;
    }

    console.log('[chat] numericUserIdStr:', numericUserIdStr, 'authUserId:', authUserId);

    const authorName = userRecord.nickname || userFirstName;
    const assistantName = userRecord.assistant_name || 'Lev';
    const userTimezone = userRecord.timezone || 'America/Sao_Paulo';
    const currentContextL3 = userRecord.current_context || 'Sem dossiê ainda.';
    const pendingQuestion = userRecord.pending_question || null;

    ensureMemoryHealth(numericUserIdStr).catch((e) => console.error('[Health]', e));

    const sessionId = clientSessionId || (await getOrCreateSession(numericUserIdStr));

    // Data/hora canônica do servidor
    const canonicalDateTimeBlock = buildDateTimeBlock(userTimezone);
    const { day, month, year } = getCurrentDateParts(userTimezone);
    const canonicalDateISO = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
   // app/api/chat/route.ts (trecho crítico - linhas ~290-320)

// Localização
let locationContext = '';
if (location) {
  const { latitude, longitude } = location;
  const latMasked = parseFloat(latitude.toFixed(2));
  const lngMasked = parseFloat(longitude.toFixed(2));

  // ✅ CHAMADA ÚNICA: checkProximidade já salva em jarvis.user_locations
  const endereco = await checkProximidade(latitude, longitude, numericUserIdStr);
  locationContext = `${endereco}\n(Localização aproximada)`;

  // ❌ REMOVIDO: NÃO DUPLICAR salvamento aqui!
  // await supabase.from('user_locations').upsert(...) ← REMOVIDO!

  // ✅ Armazenar em config para fallback rápido (sem dados sensíveis)
  await supabase
    .from('config')
    .upsert(
      {
        key: `last_location_${numericUserIdStr}`,
        value: JSON.stringify({
          lat_approx: latMasked,
          lng_approx: lngMasked,
          endereco,
          ts: Date.now(),
        }),
      },
      { onConflict: 'key' }
    );

  const alertaGeo = await verificarAlertasDeProximidade(authUserId, latitude, longitude);
  if (alertaGeo.temAlerta)
    return NextResponse.json({ reply: alertaGeo.mensagem, sessionId, ok: true });
  if (!messageText) messageText = '[Enviou Localização]';
};

    // ========== 1. Gerar embedding e buscar memórias HD ==========
    let queryEmbedding: number[] | null = null;
    let hdSearchResults: Array<{ similarity: number; emotional_weight: number; summary?: string; id: string }> = [];
    let hdBlock = '';
    let hdMemoryIds: string[] = [];

    try {
      queryEmbedding = await getCachedEmbedding(messageText);
      if (queryEmbedding) {
        const { data: search, error } = (await supabase.rpc('match_memories', {
          query_embedding: queryEmbedding,
          match_threshold: 0.10,
          match_count: 8,
        })) as { data: any[] | null; error?: any };

        if (error) {
          console.error('[Memória HD] Erro na RPC:', error);
        } else if (search?.length) {
          hdSearchResults = search.map((r: any) => ({
            similarity: r.similarity,
            emotional_weight: r.emotional_weight ?? 0.5,
            summary: r.summary,
            id: r.id,
          }));
          hdBlock = hdSearchResults.filter(r => !r.summary?.startsWith('[CINZA]'))
            .map(r => r.summary).join('\n---\n');
          hdMemoryIds = hdSearchResults.map(r => r.id);
        }
      }
    } catch (err) {
      console.error('[Embedding] Erro:', err);
    }

    // ========== 2. Construir RAM block ==========
    let ramBlock = '';
    const { data: historySession } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('user_id', numericUserIdStr)
      .eq('session_id', sessionId)
      .neq('category', 'archived')
      .order('created_at', { ascending: false })
      .limit(10);

    if (historySession && historySession.length >= 2) {
      const currentContexts = classifyContextRegex(messageText);
      const shiftDetected = await detectTopicShiftWithL4(numericUserIdStr, currentContexts);
      if (historySession.length > 5 && shiftDetected) {
        const summary = compressToSummary(historySession.slice(3));
        const recentRaw = [...historySession].slice(0, 3).reverse().map(
          (h: any) => `${authorName}: ${h.content}\n${assistantName}: ${(h.metadata?.ai_reply || '').replace(/\[.*?\]/g, '').trim()}`
        ).join('\n\n');
        ramBlock = `${summary}\n\n${recentRaw}`;
      } else {
        ramBlock = [...historySession].reverse().map(
          (h: any) => `${authorName}: ${h.content}\n${assistantName}: ${(h.metadata?.ai_reply || '').replace(/\[.*?\]/g, '').trim()}`
        ).join('\n\n');
      }
    } else {
      const semanticBlock = await semanticRamCompression(
        historySession || [],
        numericUserIdStr,
        messageText,
        queryEmbedding ?? undefined
      );
      ramBlock = semanticBlock || (hdBlock ? `[Contexto anterior consolidado]\n${hdBlock}` : ' ');
    }
    if (ramBlock.length > RAM_MAX_CHARS) ramBlock = ramBlock.slice(-RAM_MAX_CHARS);

    // ========== 3. Calcular Emotional Score ==========
    const emotional = await computeEmotionalScore(
      messageText,
      numericUserIdStr,
      hdSearchResults,
      ramBlock
    );
    console.log('[Emotional] Score:', emotional.score, 'Traj:', emotional.trajectory, 'Triggers:', emotional.triggers);

    // ========== 4. Classificar contexto com L4 (com cache) ==========
    console.time('[Performance] context_classification');
    const contextCacheKey = `context_${numericUserIdStr}_${Buffer.from(messageText.slice(0, 50)).toString('base64')}`;
    let detectedContexts = cache.get<ContextType[]>(contextCacheKey);
    if (!detectedContexts) {
      detectedContexts = await classifyContextWithL4(messageText, numericUserIdStr);
      cache.set(contextCacheKey, detectedContexts, 20000);
    }
    console.timeEnd('[Performance] context_classification');

    // ========== 5. Obter dimensão emocional do tópico principal ==========
    let topicEmotionalDimension: number | undefined;
    if (detectedContexts.length > 0) {
      const mainTopic = detectedContexts[0];
      const { data: topicData } = await supabase
        .from('topic_index')
        .select('emotional_dimension')
        .eq('user_id', numericUserIdStr)
        .eq('topic', mainTopic)
        .maybeSingle();
      if (topicData?.emotional_dimension != null) {
        topicEmotionalDimension = topicData.emotional_dimension;
      }
    }

    // ========== 6. Rotear modelo ==========
    const modelRoute = routeModel(detectedContexts, emotional.score, topicEmotionalDimension);
    const temperature = getTemperature(detectedContexts);
    const blockPlan = planContextualBlocks(detectedContexts);
    console.log('[chat] contexts:', detectedContexts, '| model:', modelRoute.label, '| emotionalScore:', emotional.score);

    // ========== 7. Atualizar topic index ==========
    await updateTopicIndex(numericUserIdStr, detectedContexts, messageText, emotional.score);
    const relatedTopicsBlock = await getRelatedTopics(numericUserIdStr, detectedContexts[0] || 'casual');

    // ========== 8. Pesquisa forçada ==========
    let forcedSearchResult = '';
    if (shouldForceSearch(messageText, detectedContexts)) {
      const searchQuery = refineSearchQuery(messageText, detectedContexts);
      try {
        const result = await searchWeb(searchQuery);
        forcedSearchResult = `\n[PESQUISA AUTOMÁTICA REALIZADA]\nConsulta: "${searchQuery}"\nResultado:\n${result}`;
      } catch (e) {
        forcedSearchResult = '\n[ERRO NA PESQUISA] Não foi possível obter informações atualizadas.';
      }
    }

    // ========== 9. Cargas contextuais condicionais (COM CACHE) ==========
    // Events
    const eventsCacheKey = `events_${numericUserIdStr}`;
    let events = cache.get<any[]>(eventsCacheKey);
    if (!events) {
      const { data } = await supabase
        .from('events')
        .select('title, event_date, category, decay_type, relevance_score, emotional_weight, is_recurring, notes')
        .eq('user_id', numericUserIdStr)
        .order('relevance_score', { ascending: false });
      events = data || [];
      cache.set(eventsCacheKey, events);
    }

    // Memory ashes
    const ashesCacheKey = `ashes_${numericUserIdStr}`;
    let ashes = cache.get<any[]>(ashesCacheKey);
    if (!ashes) {
      const { data } = await supabase
        .from('memory_ashes')
        .select('ash_summary, period_start, period_end')
        .eq('user_id', numericUserIdStr)
        .order('period_end', { ascending: false })
        .limit(5);
      ashes = data || [];
      cache.set(ashesCacheKey, ashes);
    }

    // Principles
    const principlesCacheKey = `principles_${numericUserIdStr}`;
    let principles = cache.get<any[]>(principlesCacheKey);
    if (!principles) {
      const { data } = await supabase
        .from('principles')
        .select('content, category')
        .order('created_at', { ascending: true });
      principles = data || [];
      cache.set(principlesCacheKey, principles);
    }

    // Children
    const childrenCacheKey = `children_${numericUserIdStr}`;
    let childrenData = cache.get<any[]>(childrenCacheKey);
    if (!childrenData) {
      const { data } = await supabase
        .from('children')
        .select('name, nickname, lev_notes')
        .eq('parent_id', numericUserIdStr)
        .not('lev_notes', 'is', null);
      childrenData = data || [];
      cache.set(childrenCacheKey, childrenData);
    }

    // Person notes
    const personNotesCacheKey = `person_notes_${numericUserIdStr}`;
    let personNotesData = cache.get<any[]>(personNotesCacheKey);
    if (!personNotesData) {
      const { data } = await supabase
        .from('person_notes')
        .select('person_name, person_type, note, noted_at')
        .eq('user_id', numericUserIdStr)
        .order('noted_at', { ascending: false })
        .limit(20);
      personNotesData = data || [];
      cache.set(personNotesCacheKey, personNotesData);
    }

    // Gaps block
    const gapsCacheKey = `gaps_${numericUserIdStr}_${Buffer.from(messageText.slice(0, 50)).toString('base64')}`;
    let gapsBlock = cache.get<string>(gapsCacheKey);
    if (!gapsBlock) {
      gapsBlock = await buildGapsBlock(numericUserIdStr, messageText);
      cache.set(gapsCacheKey, gapsBlock, 60000);
    }

    // Topic block
    let topicBlock = '';
    if (blockPlan.loadTopics) {
      const topicCacheKey = `topic_${numericUserIdStr}_${Buffer.from(messageText.slice(0, 50)).toString('base64')}`;
      topicBlock = cache.get<string>(topicCacheKey) || '';
      if (!topicBlock) {
        topicBlock = await buildTopicBlock(numericUserIdStr, messageText).catch(() => '');
        cache.set(topicCacheKey, topicBlock, 60000);
      }
    }

    // Diary block
    let diaryBlock = '';
    if (blockPlan.loadDiary) {
      const diaryCacheKey = `diary_${numericUserIdStr}`;
      diaryBlock = cache.get<string>(diaryCacheKey) || '';
      if (!diaryBlock) {
        diaryBlock = await buildDiaryGoalsBlock(numericUserIdStr).catch(() => '');
        cache.set(diaryCacheKey, diaryBlock, 60000);
      }
    }

    // Recommendations block
    let recsBlock = '';
    if (blockPlan.loadRecommendations) {
      const recsCacheKey = `recs_${numericUserIdStr}_${Buffer.from(messageText.slice(0, 50)).toString('base64')}`;
      recsBlock = cache.get<string>(recsCacheKey) || '';
      if (!recsBlock) {
        recsBlock = await buildRecommendationsBlock(numericUserIdStr, messageText).catch(() => '');
        cache.set(recsCacheKey, recsBlock, 60000);
      }
    }

    // Google e Microsoft Calendar
    let googleCtx = null;
    let msCtx = null;
    if (blockPlan.loadCalendar) {
      const calendarCacheKey = `calendar_${authUserId}`;
      const cached = cache.get<{ google: any; ms: any }>(calendarCacheKey);
      if (cached) {
        googleCtx = cached.google;
        msCtx = cached.ms;
      } else {
        googleCtx = await getGoogleContext().catch(() => null);
        msCtx = await getMicrosoftCalendarContext().catch(() => null);
        cache.set(calendarCacheKey, { google: googleCtx, ms: msCtx }, 30000);
      }
    }

    // Emails
    let emailBlock = null;
    if (blockPlan.loadEmail) {
      const emailCacheKey = `emails_${authUserId}`;
      emailBlock = cache.get(emailCacheKey);
      if (!emailBlock) {
        emailBlock = await getRecentEmails(undefined, 3, false).catch(() => null);
        cache.set(emailCacheKey, emailBlock, 30000);
      }
    }

    // ✅ FERIADOS NACIONAIS PRÓXIMOS (adicionado v8.6)
    let holidaysBlock = '';
    try {
      const holidays = await getUpcomingHolidays(10); // próximos 10 feriados
      if (holidays.length > 0) {
        holidaysBlock = `\n[FERIADOS NACIONAIS PRÓXIMOS]\n${holidays.map(h => `- ${h.name}: ${new Date(h.date).toLocaleDateString('pt-BR')}`).join('\n')}`;
      }
    } catch (err) {
      console.error('[Holidays] Erro ao buscar feriados:', err);
    }

    // Onboarding
    let onboardingState = null;
    const onboardingCacheKey = `onboarding_${numericUserIdStr}`;
    onboardingState = cache.get(onboardingCacheKey);
    if (!onboardingState) {
      const { data } = await supabase.from('onboarding_progress').select('*').eq('user_id', numericUserIdStr).single();
      onboardingState = data || null;
      if (!onboardingState) onboardingState = await getOrCreateOnboardingStatePersistent(numericUserIdStr);
      cache.set(onboardingCacheKey, onboardingState, 60000);
    }
    const onboardingBlock = buildOnboardingBlock(onboardingState);

    // Montar blocos de eventos
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const sortedEvents = [...events].sort(
      (a, b) => Math.abs(new Date(a.event_date).getTime() - hoje.getTime()) - Math.abs(new Date(b.event_date).getTime() - hoje.getTime())
    );
    const upcomingEvents = sortedEvents.filter((e) => {
      const diff = Math.ceil((new Date(e.event_date).getTime() - hoje.getTime()) / 86400000);
      return diff >= 0 && diff <= 7;
    });
    const highRelevanceEvents = sortedEvents.filter((e) => (e.relevance_score || 0) >= 0.7 && !upcomingEvents.includes(e));
    const activeEvents = sortedEvents.filter(
      (e) => new Date(e.event_date) >= hoje || (e.decay_type === 'permanent' && new Date(e.event_date) < hoje)
    );
    const eventsBlock =
      activeEvents.length > 0
        ? [
            upcomingEvents.length > 0 ? `🔴 NOS PRÓXIMOS DIAS:\n${upcomingEvents.map((e) => `  - ${e.title}: ${e.event_date}${e.notes ? ` (${e.notes})` : ''}`).join('\n')}` : null,
            highRelevanceEvents.length > 0 ? `🟡 IMPORTANTES:\n${highRelevanceEvents.map((e) => `  - ${e.title}: ${e.event_date}`).join('\n')}` : null,
          ].filter(Boolean).join('\n\n')
        : 'Nenhum evento cadastrado.';

    const ashesBlock = ashes.length > 0 ? ashes.map((a: any) => a.ash_summary).join('\n') : null;

    // Notas de pessoas (filtragem em memória)
    let personNotesBlock = '';
    const msgLower = messageText.toLowerCase();
    const childNotes = childrenData.filter(
      (c: any) => msgLower.includes((c.nickname || '').toLowerCase()) || msgLower.includes((c.name || '').split(' ')[0].toLowerCase())
    );
    const pNotes = personNotesData.filter((n: any) =>
      n.person_name.toLowerCase().split(' ').some((p: string) => p.length >= 3 && new RegExp(`\\b${p}\\b`).test(msgLower))
    );

    if (childNotes.length > 0 || pNotes.length > 0) {
      const lines: string[] = [];
      for (const c of childNotes) lines.push(`${c.nickname || c.name.split(' ')[0]}: ${c.lev_notes}`);
      for (const n of pNotes) lines.push(`${n.person_name} [${n.noted_at}]: ${n.note}`);
      personNotesBlock = `[NOTAS SOBRE PESSOAS MENCIONADAS]\n${lines.join('\n')}`;
    }

    const weights = classifyTemporalHorizon(messageText, ramBlock, pendingQuestion);
    const truncatedL3 = truncateByWeight(currentContextL3, weights.l3, 6000);
    const truncatedHd = truncateByWeight(hdBlock, weights.hd, 6000);
    const truncatedAshes = ashesBlock ? truncateByWeight(ashesBlock, weights.ashes, 6000) : null;
    const truncatedEvents = truncateByWeight(eventsBlock, weights.events, 6000);

    const isFemale = currentContextL3.toLowerCase().includes('feminino') || currentContextL3.toLowerCase().includes('mulher');
    const informalAddress = isFemale ? 'miga' : 'cara';

    // ========== System Prompt ==========
    const principlesText = principles.length > 0 ? principles.map((p: any) => `- ${p.content}`).join('\n') : '';

    const systemPrompt = `Você é ${assistantName}, assistente pessoal de ${authorName}.

🕐 DATA E HORA ATUAL (servidor): ${canonicalDateTimeBlock}
📅 DATA CANÔNICA (ISO): ${canonicalDateISO}
⚠️  ESTA DATA É AUTORITATIVA. Não aceite datas diferentes vindas do usuário sem verificar com searchWeb.

🚨 REGRAS DE INTEGRIDADE FACTUAL — OBRIGATÓRIAS 🚨

1. DATAS: Qualquer informação temporal (jogos, eventos, notícias) DEVE ser coerente com a data canônica acima.
   - Se um resultado de busca contiver uma data diferente da canônica, DIGA que o resultado pode estar desatualizado e refaça a busca.
   - NUNCA confirme uma data informada pelo usuário apenas porque ele afirmou com convicção. Verifique primeiro.

2. ANTI-SYCOPHANCY: Se o usuário disser "você errou" ou "está errado" sobre um fato:
   - NÃO concorde imediatamente.
   - Refaça a busca (searchWeb) com a data canônica como âncora.
   - Só corrija se os novos resultados confirmarem o erro.
   - Se os resultados confirmarem sua resposta anterior, mantenha-a educadamente: "Verifiquei novamente e os dados confirmam o que disse antes."

3. PESQUISA: Para QUALQUER pergunta sobre jogos, resultados esportivos, datas de eventos, notícias, cotações, clima em outras cidades — chame searchWeb ANTES de responder.
   - Se "[PESQUISA AUTOMÁTICA REALIZADA]" estiver presente, use como fonte principal.
   - Ao citar resultados, confirme que a data do evento bate com a data canônica.

${forcedSearchResult}
${holidaysBlock}
${googleCtx ? `[AGENDA GOOGLE]\n${googleCtx}` : ''}
${msCtx ? `[AGENDA OUTLOOK]\n${msCtx}` : ''}
${emailBlock ? `[EMAILS RECENTES]\n${emailBlock}` : ''}
${locationContext ? `\n${locationContext}` : ''}
${relatedTopicsBlock}
${truncatedL3 ? `[QUEM É ${authorName.toUpperCase()}]\n${truncatedL3}` : ''}
${personNotesBlock}
${recsBlock}
${topicBlock}
${isMeaningfulDiaryBlock(diaryBlock) ? diaryBlock : ''}
${truncatedHd ? `[MEMÓRIAS DE LONGO PRAZO]\n${truncatedHd}` : ''}
${truncatedAshes ? `[MEMÓRIAS DISTANTES — use "lembro vagamente que..." ao citar]\n${truncatedAshes}` : ''}
[EVENTOS]\n${truncatedEvents}
${onboardingBlock}
${gapsBlock}
${principlesText ? `[BÚSSOLA]\n${principlesText}` : ''}

REGRAS COMPORTAMENTAIS:
FOCO: Responda O QUE FOI PERGUNTADO. Nunca repita sugestão rejeitada.
TOM: Amigo inteligente, direto, humano. Use "${informalAddress}" no máximo 1x por conversa. Nunca comece com "Considerando que".
PROIBIDO: "Anotado!", "Registrado!". Se salvou via ferramenta: "Feito." ou "Tá na agenda."
PRESENÇA EMOCIONAL: Seja empático quando algo difícil for compartilhado.
MEMÓRIA: Use notas naturalmente. Nunca diga "Tenho uma nota aqui que diz...".
FAMÍLIA: Nunca assuma que mãe/pai de um filho é o cônjuge atual.
PERGUNTA PENDENTE: ${pendingQuestion ? `Você fez esta pergunta: "${pendingQuestion}". A mensagem atual é a resposta — processe e limpe a pendência.` : 'Nenhuma.'}
CLASSIFICAÇÃO: Ao final inclua obrigatoriamente [CLASSE: info] ou [CLASSE: noise].`.trim();

    // Histórico de conversa
    const { data: historyForMessages } = await supabase
      .from('brain').select('content, metadata').eq('user_id', numericUserIdStr).neq('category', 'archived').order('created_at', { ascending: false }).limit(8);

    const conversationMessages: any[] = [
      { role: 'system', content: systemPrompt },
      ...(historyForMessages || []).reverse().flatMap((h: any) => [
        { role: 'user', content: h.content },
        { role: 'assistant', content: (h.metadata?.ai_reply || '').replace(/\[.*?\]/g, '').trim() },
      ]),
      { role: 'user', content: messageText },
    ];

    // Comandos especiais
    if (/ignore isso|ignora isso|não salva|nao salva|apaga isso|esquece isso|delete isso/i.test(messageText)) {
      const { data: lastEntry } = await supabase.from('brain').select('id').eq('user_id', numericUserIdStr).order('created_at', { ascending: false }).limit(1).single();
      if (lastEntry) await supabase.from('brain').delete().eq('id', lastEntry.id);
      return NextResponse.json({ reply: 'Feito — apaguei o que foi dito antes. 🗑️', sessionId, ok: true });
    }

    const noisePatterns = /^(ok|oi|olá|ola|bom dia|boa tarde|boa noite|tudo bem|tudo bom|blz|vlw|valeu|obrigad|kkk|haha|rs|👍|🙏|😂|!)[\s!?.]*$/i;
    const isLikelyNoise = noisePatterns.test(messageText.trim()) && messageText.length < 30;

    let extractionSummary = '';
    if (!isLikelyNoise) {
      try {
        extractionSummary = await extractAndSummarize(numericUserIdStr, authorName, messageText);
      } catch (e) {
        console.error('[Extrator/pre]', e);
      }
    }

    conversationMessages.push({
      role: 'system',
      content: extractionSummary
        ? `[INTERNO]\nRegistrado: ${extractionSummary}\nConfirme em 1 frase curta. PROIBIDO: "Anota aí", "Anotado!", "Registrado!".`
        : `[INTERNO]\nVocê é o assistente — NUNCA diga "Anota aí". Confirme brevemente.`,
    });

    // ReAct Loop
    let finalResponse = '';
    let attempts = 0;

    while (attempts < 5) {
      const response = await callOpenRouterWithTools(conversationMessages, tools, modelRoute.model, temperature, 25000);
      const { content, toolCalls } = response;

      if (!toolCalls || toolCalls.length === 0) {
        finalResponse = content;
        break;
      }

      conversationMessages.push({ role: 'assistant', content: null, tool_calls: toolCalls });

      for (const toolCall of toolCalls) {
        const result = await executeTool(toolCall, authUserId, numericUserIdStr);
        conversationMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      }
      attempts++;
    }

    if (!finalResponse) finalResponse = 'Ops, não consegui processar. Pode repetir?';

    let category = 'info';
    const categoryMatch = finalResponse.match(/\[CLASSE:\s*(\w+)\]/i);
    if (categoryMatch) category = categoryMatch[1].toLowerCase();
    finalResponse = finalResponse.replace(/\[CLASSE:\s*\w+\]/gi, '').trim();

    // =================================================================
    // [FIX v8.2] Sanitização de saída – remove marcadores e protege dados
    // =================================================================
    finalResponse = finalResponse.replace(/\[INTERNO:.*?\]/gi, '');
    finalResponse = finalResponse.replace(/\[DEBUG:.*?\]/gi, '');
    finalResponse = finalResponse.replace(/\[ERROR:.*?\]/gi, '');
    finalResponse = finalResponse.trim();
    finalResponse = sanitizeSensitiveData(finalResponse);
    // =================================================================

    // =================================================================
    // [FIX v8.3] Fallback universal para resposta vazia
    // =================================================================
    if (!finalResponse && extractionSummary) {
      const feedbacks = ['Certo.', 'Ok.', 'Guardei.', 'Entendido.'];
      finalResponse = feedbacks[Math.floor(Math.random() * feedbacks.length)];
    }

    if (!finalResponse) {
      console.warn('[Sanitização] Resposta ficou completamente vazia. Usando fallback genérico.');
      finalResponse = 'Entendi. Podemos continuar?';
    }
    // =================================================================

    if (pendingQuestion)
      clearPendingQuestion(numericUserIdStr).catch((e) => console.error('[PendingQ]', e));

    // Persistência
    const { error: insertError } = await supabase.from('brain').insert([{
      content: messageText,
      category,
      user_id: numericUserIdStr,
      session_id: sessionId,
      project_tag: 'geral',
      embedding: queryEmbedding ?? undefined,
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
        emotional_score: emotional.score,
        emotional_triggers: emotional.triggers,
        emotional_trajectory: emotional.trajectory,
      },
    }]);

    if (insertError) console.error('BRAIN INSERT ERRO:', insertError);
    else console.log('BRAIN INSERT OK — user:', numericUserIdStr, 'session:', sessionId, 'model:', modelRoute.label);

    const backgroundTasks: Promise<any>[] = hdMemoryIds.map((id) => reinforceMemory(id));
    if (onboardingState?.status === 'in_progress') {
      backgroundTasks.push(
        withRetry(() => processOnboardingFromMessage(numericUserIdStr, messageText, finalResponse, onboardingState)).catch((e) => console.error('[Onboarding]', e))
      );
    }
    if (!isLikelyNoise) {
      backgroundTasks.push(withRetry(() => extractRecomendacao(numericUserIdStr, messageText, finalResponse)).catch((e) => console.error('[recomendacao]', e)));
      backgroundTasks.push(withRetry(() => extractDiary(numericUserIdStr, messageText, 'anytime')).catch((e) => console.error('[diary]', e)));
      backgroundTasks.push(withRetry(() => extractGoal(numericUserIdStr, messageText)).catch((e) => console.error('[goals]', e)));
    }

    Promise.all([
      ...backgroundTasks,
      supabase.from('brain').select('*', { count: 'exact', head: true }).eq('user_id', numericUserIdStr).eq('category', 'info').then(({ count }) => {
        if (count && count >= 20) return compactMemory(numericUserIdStr, authorName);
      }),
    ]).catch((e) => console.error('[Background]', e));

    console.timeEnd('[Performance] total');
    return NextResponse.json({ reply: finalResponse, sessionId, assistantName, authorName, ok: true });
  } catch (error: any) {
    console.error('[chat] ERRO:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
};