// app/api/chat/route.ts
// Motor V8.9.9 — Redis cache (Upstash) + OpenRouter prompt caching

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
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
// import { ensureMemoryHealth } from '@/lib/chat/event-relevance';
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
import { Redis } from '@upstash/redis';
import { buildSharedContextBlock } from '@/lib/chat/shared-context';

// ── [NOVO] Personalidade isolada ──────────────────────────────────────────────
// Para ajustar tom, voz ou regras de comportamento do assistente,
// edite lib/chat/personality.ts — não mexa aqui.
import { buildPersonalityBlock } from '@/lib/chat/personality';

export const maxDuration = 60;

// ===================== CACHE (Upstash Redis) =====================
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const cache = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const val = await redis.get<T>(key);
      return val ?? null;
    } catch (e) {
      console.warn('[Cache] Redis GET falhou, continuando sem cache:', (e as Error).message);
      return null;
    }
  },

  async set<T>(key: string, value: T, ttlMs = 30000): Promise<void> {
    try {
      const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
      await redis.set(key, value, { ex: ttlSec });
    } catch (e) {
      console.warn('[Cache] Redis SET falhou:', (e as Error).message);
    }
  },
};
// ====================================================================

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

async function getOrCreateOnboardingStatePersistent(userId: string) {
  const { data: onboardingMemory } = await supabase
    .from('memories')
    .select('metadata')
    .eq('user_id', userId)
    .eq('category', 'onboarding')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (onboardingMemory?.metadata?.state) return onboardingMemory.metadata.state;
  return await initOnboarding(userId);
}

function trimAssistantReply(reply: string, maxChars = 300): string {
  if (!reply) return '';
  const cleaned = reply.replace(/\[.*?\]/g, '').trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) + '…' : cleaned;
}

// ── [NOVO] Monta o bloco de clima a partir dos dados enviados pelo app ────────
// O app (React Native) já tem os dados do card de clima.
// Basta enviá-los no body do request e este helper formata para o prompt.
// Todos os campos são opcionais — se não vier nada, retorna string vazia.
function buildWeatherBlock(weather: Record<string, any> | null | undefined): string {
  if (!weather) return '';
  const parts: string[] = [];
  if (weather.city)        parts.push(weather.city);
  if (weather.temp != null) parts.push(`${Math.round(weather.temp)}°C`);
  if (weather.condition)   parts.push(weather.condition);
  if (weather.humidity != null) parts.push(`Umidade ${weather.humidity}%`);
  if (weather.wind != null)     parts.push(`Vento ${weather.wind} km/h`);
  if (weather.feelsLike != null) parts.push(`Sensação ${Math.round(weather.feelsLike)}°C`);
  if (weather.forecast)    parts.push(`Previsão: ${weather.forecast}`);
  return parts.join(' · ');
}

export async function POST(req: NextRequest) {
  console.log('[chat] Iniciando — V8.9.9 (Redis cache + prompt caching)');
  try {
    console.time('[Performance] total');
    let messageText = '';
    let userEmail = '';
    let tempUserId = '';
    let clientSessionId: string | null = null;
    let userFirstName = 'Usuário';
    let location: { latitude: number; longitude: number } | null = null;

    // ── [NOVO] Dados de clima enviados pelo app ──────────────────────────────
    // O app que já exibe o card de clima deve incluir estes dados no request.
    // Exemplo (no mobile, ao montar o body da chamada):
    //   weather: { city: "São Paulo", temp: 24, condition: "Parcialmente nublado",
    //              humidity: 68, wind: 12, feelsLike: 23 }
    let weatherData: Record<string, any> | null = null;

    // --- Parsing do request ---
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

      // Clima via form-data (campo JSON serializado)
      const weatherField = formData.get('weather') as string | null;
      if (weatherField) {
        try { weatherData = JSON.parse(weatherField); } catch { /* ignora */ }
      }

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

      // Clima via JSON body
      if (body.weather && typeof body.weather === 'object') {
        weatherData = body.weather;
      }
    }

    // ── FIX 1: Sanitizar input ANTES de qualquer log ou persistência ──
    if (messageText) {
      messageText = sanitizeSensitiveData(messageText);
    }

    if (!messageText && !location)
      return NextResponse.json({ error: 'message obrigatório' }, { status: 400 });
    if (!userEmail && !tempUserId)
      return NextResponse.json({ error: 'userEmail ou userId obrigatório' }, { status: 400 });

    // --- Lookup do usuário ---
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

    // ── FIX 2: Não expor PII no response 404 em produção ──
    if (!userRecord) {
      console.error('[chat] USUÁRIO NÃO ENCONTRADO! email:', userEmail, 'userId:', tempUserId);
      if (process.env.NODE_ENV === 'development') {
        return NextResponse.json({
          error: 'Usuário não encontrado. Faça login novamente.',
          debug: { email: userEmail, userId: tempUserId },
        }, { status: 404 });
      }
      return NextResponse.json(
        { error: 'Usuário não encontrado. Faça login novamente.' },
        { status: 404 }
      );
    }

    const numericUserIdStr = String(userRecord.id);
    if (!numericUserIdStr || isNaN(Number(numericUserIdStr))) {
      throw new Error('Invalid numeric user ID');
    }

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

    // ensureMemoryHealth(numericUserIdStr).catch((e) => console.error('[Health]', e));

    const sessionId = clientSessionId || (await getOrCreateSession(numericUserIdStr));

    // Data/hora canônica
    const canonicalDateTimeBlock = buildDateTimeBlock(userTimezone);
    const { day, month, year } = getCurrentDateParts(userTimezone);
    const canonicalDateISO = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    // Localização
    let locationContext = '';
    if (location) {
      const { latitude, longitude } = location;
      const latMasked = parseFloat(latitude.toFixed(2));
      const lngMasked = parseFloat(longitude.toFixed(2));

      let lastKnownLocation: { city: string; state: string } | null = null;

if (!location) {
  // Sem coordenadas no request — tenta recuperar última posição salva
  const { data: savedLoc } = await supabase
    .from('user_locations')
    .select('city, state, latitude, longitude, last_updated')
    .eq('user_id', numericUserIdStr)
    .maybeSingle();

  if (savedLoc?.city) {
    lastKnownLocation = { city: savedLoc.city, state: savedLoc.state };
    const hoursAgo = Math.round(
      (Date.now() - new Date(savedLoc.last_updated).getTime()) / 3600000
    );
    locationContext = `[LOCALIZAÇÃO ANTERIOR]\n📍 ${savedLoc.city}, ${savedLoc.state}\n(última atualização: há ~${hoursAgo}h)`;
    console.log('[chat] Localização resgatada da tabela:', savedLoc.city);
  }
}

      const endereco = await checkProximidade(latitude, longitude, numericUserIdStr);
      locationContext = endereco;

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
    }

    // ========== 1. Classificação rápida para decidir se precisa de embedding ==========
    const quickContexts = classifyContextRegex(messageText);
    const isTrivialEarly = quickContexts.includes('math') || quickContexts.includes('trivial');

    let queryEmbedding: number[] | null = null;
    let hdSearchResults: Array<{ similarity: number; emotional_weight: number; summary?: string; id: string }> = [];
    let hdBlock = '';
    let hdMemoryIds: string[] = [];

    if (!isTrivialEarly) {
      try {
        queryEmbedding = await getCachedEmbedding(messageText);
        if (queryEmbedding) {
          const { data: search, error } = (await supabase.rpc('match_memories', {
            query_embedding: queryEmbedding,
            match_threshold: 0.22,
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
    }

    // ========== 2. Classificação completa com L4 ==========
    console.time('[Performance] context_classification');
    const contextCacheKey = `context_${numericUserIdStr}_${Buffer.from(messageText.slice(0, 50)).toString('base64')}`;
    let detectedContexts = await cache.get<ContextType[]>(contextCacheKey);
    if (!detectedContexts) {
      detectedContexts = await classifyContextWithL4(messageText, numericUserIdStr);
      await cache.set(contextCacheKey, detectedContexts, 20000);
    }
    console.timeEnd('[Performance] context_classification');

    // ========== 3. Detecção de shift (condicional para triviais) ==========
    const shiftDetected = !isTrivialEarly
      ? await detectTopicShiftWithL4(numericUserIdStr, detectedContexts)
      : false;
    console.log('[Shift] detectado:', shiftDetected);

    // ========== 4. Construção do histórico ==========
    const { data: historySession } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('user_id', numericUserIdStr)
      .eq('session_id', sessionId)
      .neq('category', 'archived')
      .order('created_at', { ascending: false })
      .limit(6);

    let ramBlock = '';
    let recentPairs: any[] = [];

    const hasEnoughHistory = historySession && historySession.length >= 2;

    if (hasEnoughHistory) {
      const pairsToUse = shiftDetected
        ? historySession.slice(0, 1)
        : historySession.slice(0, 4);

      recentPairs = [...pairsToUse].reverse().flatMap((h: any) => [
        { role: 'user' as const, content: h.content },
        { role: 'assistant' as const, content: trimAssistantReply(h.metadata?.ai_reply || '') },
      ]);

      if (shiftDetected && historySession && historySession.length > 1) {
        const validHistory = historySession.filter(h => h.metadata?.ai_reply);
        if (validHistory.length > 1) {
          const summary = compressToSummary(validHistory.slice(1));
          ramBlock = `[CONTEXTO ANTERIOR RESUMIDO]\n${summary}`;
        } else {
          ramBlock = '';
        }
      }
    } else {
      if (historySession && historySession.length > 0) {
        ramBlock = [...historySession].reverse().map(
          (h: any) => `${authorName}: ${h.content}\n${assistantName}: ${trimAssistantReply(h.metadata?.ai_reply || '')}`
        ).join('\n\n');
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
    }

    // ========== 5. Emotional Score ==========
    const emotional = await computeEmotionalScore(
      messageText,
      numericUserIdStr,
      hdSearchResults,
      ramBlock
    );
    console.log('[Emotional] Score:', emotional.score, 'Traj:', emotional.trajectory);

    // ========== 6. Segunda busca HD condicional ==========
    if (emotional.score > 0.6 && queryEmbedding && hdSearchResults.length < 6) {
      try {
        const { data: extraSearch } = (await supabase.rpc('match_memories', {
          query_embedding: queryEmbedding,
          match_threshold: 0.12,
          match_count: 12,
        })) as { data: any[] | null; error?: any };

        if (extraSearch?.length) {
          const existingIds = new Set(hdMemoryIds);
          const extras = extraSearch.filter((r: any) => !existingIds.has(r.id));
          if (extras.length) {
            const newResults = extras.map((r: any) => ({
              similarity: r.similarity,
              emotional_weight: r.emotional_weight ?? 0.5,
              summary: r.summary,
              id: r.id,
            }));
            hdSearchResults.push(...newResults);
            hdBlock = hdSearchResults.filter(r => !r.summary?.startsWith('[CINZA]'))
              .map(r => r.summary).join('\n---\n');
            hdMemoryIds = hdSearchResults.map(r => r.id);
            console.log('[Memória HD] Segunda busca adicionou', extras.length, 'memórias emocionais');
          }
        }
      } catch (err) {
        console.error('[Memória HD] Erro na segunda busca:', err);
      }
    }

    // ========== 7. Tópico emocional (paralelizado no Promise.all) ==========
    let topicEmotionalDimension: number | undefined;

    // ========== 8. Cargas contextuais condicionais + topicEmotionalDimension ==========
    const [
  events,
  ashes,
  principles,
  childrenData,
  personNotesData,
  onboardingState,
  topicEmotionalDimValue,
  sharedContextResult,           // ← novo
] = await Promise.all([
  // ── events (inalterado) ───────────────────────────────────
  (async () => {
    const key = `events_${numericUserIdStr}`;
    const cached = await cache.get<any[]>(key);
    if (cached) return cached;
    const { data } = await supabase
      .from('events')
      .select('title, event_date, category, decay_type, relevance_score, emotional_weight, is_recurring, notes')
      .eq('user_id', numericUserIdStr)
      .order('relevance_score', { ascending: false });
    const val = data || [];
    await cache.set(key, val);
    return val;
  })(),
  // ── ashes (inalterado) ────────────────────────────────────
  (async () => {
    const key = `ashes_${numericUserIdStr}`;
    const cached = await cache.get<any[]>(key);
    if (cached) return cached;
    const { data } = await supabase
      .from('memory_ashes')
      .select('ash_summary, period_start, period_end')
      .eq('user_id', numericUserIdStr)
      .order('period_end', { ascending: false })
      .limit(5);
    const val = data || [];
    await cache.set(key, val);
    return val;
  })(),
  // ── principles (inalterado) ───────────────────────────────
  (async () => {
    const key = `principles_${numericUserIdStr}`;
    const cached = await cache.get<{ global: any[]; individual: any[] }>(key);
    if (cached) return cached;
    const [globalRes, userRes] = await Promise.all([
      supabase.schema('jarvis').from('principles').select('content, category').is('user_id', null).order('created_at', { ascending: true }),
      supabase.schema('jarvis').from('principles').select('content, category').eq('user_id', numericUserIdStr).order('created_at', { ascending: true }),
    ]);
    const val = { global: globalRes.data || [], individual: userRes.data || [] };
    await cache.set(key, val, 60000);
    return val;
  })(),
  // ── childrenData (inalterado) ─────────────────────────────
  (async () => {
    const key = `children_${numericUserIdStr}`;
    const cached = await cache.get<any[]>(key);
    if (cached) return cached;
    const { data } = await supabase
      .from('children')
      .select('name, nickname, lev_notes')
      .eq('parent_id', numericUserIdStr)
      .not('lev_notes', 'is', null);
    const val = data || [];
    await cache.set(key, val);
    return val;
  })(),
  // ── personNotesData (inalterado) ──────────────────────────
  (async () => {
    const key = `person_notes_${numericUserIdStr}`;
    const cached = await cache.get<any[]>(key);
    if (cached) return cached;
    const { data } = await supabase
      .from('person_notes')
      .select('person_name, person_type, note, noted_at')
      .eq('user_id', numericUserIdStr)
      .order('noted_at', { ascending: false })
      .limit(20);
    const val = data || [];
    await cache.set(key, val);
    return val;
  })(),
  // ── onboardingState (inalterado) ──────────────────────────
  (async () => {
    const key = `onboarding_${numericUserIdStr}`;
    const cached = await cache.get(key);
    if (cached) return cached;
    const { data } = await supabase
      .from('onboarding_progress')
      .select('*')
      .eq('user_id', numericUserIdStr)
      .maybeSingle();
    let state = data || await getOrCreateOnboardingStatePersistent(numericUserIdStr);
    await cache.set(key, state, 60000);
    return state;
  })(),
  // ── topicEmotionalDimValue (inalterado) ───────────────────
  (async () => {
    if (!detectedContexts.length) return undefined;
    const { data } = await supabase
      .from('topic_index')
      .select('emotional_dimension')
      .eq('user_id', numericUserIdStr)
      .eq('topic', detectedContexts[0])
      .maybeSingle();
    return data?.emotional_dimension ?? undefined;
  })(),
  // ── sharedContextResult (NOVO) ────────────────────────────
  (async () => {
    const key = `shared_ctx_${numericUserIdStr}_${detectedContexts.slice(0, 3).join('_')}`;
    const cached = await cache.get<{ block: string; hasData: boolean }>(key);
    if (cached) return cached;
    const result = await buildSharedContextBlock(
      authUserId!,
      numericUserIdStr,
      detectedContexts,
      authorName,
    );
    await cache.set(key, result, 20000); // 20s — dados de relacionamento mudam pouco
    return result;
  })(),
]);
 
topicEmotionalDimension = topicEmotionalDimValue;

    // ========== 9. Roteamento e blockPlan ==========
    const modelRoute = routeModel(detectedContexts, emotional.score, topicEmotionalDimension);
    const temperature = getTemperature(detectedContexts);
    const blockPlan = planContextualBlocks(detectedContexts);
    console.log('[chat] contexts:', detectedContexts, '| model:', modelRoute.label, '| blockPlan:', blockPlan);

    // ========== 10. Pesquisa forçada ==========
    // ── [MODIFICADO] Pesquisa de clima só é forçada se o app NÃO enviou dados ──
    // Se weatherData veio no request, não buscamos clima — usamos o dado local.
    const isProductRecommendation = /qual(quer)?\s+(cor|tinta|coloraç|produto|marca|remédio|medicamento|creme|shampoo|xampu|esmalte|batom|perfume|suplemento|vitamina|proteína|modelo|aparelho|celular|notebook|app|aplicativo)/i.test(messageText)
      || /me indica|me recomenda|qual (devo|posso|seria|é o melhor|usar|comprar|tomar)/i.test(messageText);

    const shouldSearch = shouldForceSearch(messageText, detectedContexts) || isProductRecommendation;
    const isClimaQuery = detectedContexts.includes('clima');
    const skipSearchForWeather = isClimaQuery && !!weatherData;

    let forcedSearchResult = '';
    if (shouldSearch && !skipSearchForWeather) {
      const searchQuery = refineSearchQuery(messageText, detectedContexts);
      try {
        const result = await searchWeb(searchQuery);
        forcedSearchResult = `\n[PESQUISA AUTOMÁTICA REALIZADA]\nConsulta: "${searchQuery}"\nResultado:\n${result}`;
      } catch (e) {
        forcedSearchResult = '\n[ERRO NA PESQUISA] Não foi possível obter informações atualizadas.';
      }
    }

    // ========== 11. Blocos condicionais + relatedTopics com cache ==========
    const [gapsBlock, topicBlock, diaryBlock, recsBlock, relatedTopicsBlock] = await Promise.all([
      blockPlan.loadGaps
        ? (async () => {
            const key = `gaps_${numericUserIdStr}_${Buffer.from(messageText.slice(0, 50)).toString('base64')}`;
            let val = await cache.get<string>(key);
            if (!val) {
              val = await buildGapsBlock(numericUserIdStr, messageText);
              await cache.set(key, val, 60000);
            }
            return val;
          })()
        : Promise.resolve(''),
      blockPlan.loadTopics
        ? (async () => {
            const key = `topic_${numericUserIdStr}_${Buffer.from(messageText.slice(0, 50)).toString('base64')}`;
            let val = await cache.get<string>(key);
            if (!val) {
              val = await buildTopicBlock(numericUserIdStr, messageText).catch(() => '');
              await cache.set(key, val, 60000);
            }
            return val;
          })()
        : Promise.resolve(''),
      blockPlan.loadDiary
        ? (async () => {
            const key = `diary_${numericUserIdStr}`;
            let val = await cache.get<string>(key);
            if (!val) {
              val = await buildDiaryGoalsBlock(numericUserIdStr).catch(() => '');
              await cache.set(key, val, 60000);
            }
            return val;
          })()
        : Promise.resolve(''),
      blockPlan.loadRecommendations
        ? (async () => {
            const key = `recs_${numericUserIdStr}_${Buffer.from(messageText.slice(0, 50)).toString('base64')}`;
            let val = await cache.get<string>(key);
            if (!val) {
              val = await buildRecommendationsBlock(numericUserIdStr, messageText).catch(() => '');
              await cache.set(key, val, 60000);
            }
            return val;
          })()
        : Promise.resolve(''),
      blockPlan.loadTopics
        ? (async () => {
            const key = `related_${numericUserIdStr}_${detectedContexts[0] || 'casual'}`;
            const cached = await cache.get<string>(key);
            if (cached) return cached;
            const val = await getRelatedTopics(numericUserIdStr, detectedContexts[0] || 'casual');
            await cache.set(key, val, 30000);
            return val;
          })()
        : Promise.resolve(''),
    ]);

    // ========== 12. Calendários e emails ==========
    let googleCtx = null;
    let msCtx = null;
    if (blockPlan.loadCalendar) {
      const calendarCacheKey = `calendar_${authUserId}`;
      const cached = await cache.get<{ google: any; ms: any }>(calendarCacheKey);
      if (cached) {
        googleCtx = cached.google;
        msCtx = cached.ms;
      } else {
        [googleCtx, msCtx] = await Promise.all([
          getGoogleContext().catch(() => null),
          getMicrosoftCalendarContext().catch(() => null),
        ]);
        await cache.set(calendarCacheKey, { google: googleCtx, ms: msCtx }, 30000);
      }
    }

    let emailBlock = null;
    if (blockPlan.loadEmail) {
      const emailCacheKey = `emails_${authUserId}`;
      emailBlock = await cache.get(emailCacheKey);
      if (!emailBlock) {
        emailBlock = await getRecentEmails(undefined, 3, false).catch(() => null);
        await cache.set(emailCacheKey, emailBlock, 30000);
      }
    }

    // Feriados condicionais com cache
    let holidaysBlock = '';
    const needsHolidays = detectedContexts.includes('agenda') || detectedContexts.includes('evento') || detectedContexts.includes('familia');
    if (needsHolidays) {
      try {
        const holidaysCacheKey = `holidays_${canonicalDateISO}`;
        let holidays = await cache.get<any[]>(holidaysCacheKey);
        if (!holidays) {
          holidays = await getUpcomingHolidays(10);
          await cache.set(holidaysCacheKey, holidays, 3600000);
        }
        if (holidays.length > 0) {
          holidaysBlock = `\n[FERIADOS NACIONAIS PRÓXIMOS]\n${holidays.map(h => `- ${h.name}: ${new Date(h.date).toLocaleDateString('pt-BR')}`).join('\n')}`;
        }
      } catch (err) {
        console.error('[Holidays] Erro ao buscar feriados:', err);
      }
    }

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

    const ashesBlockRaw = ashes.length > 0 ? ashes.map((a: any) => a.ash_summary).join('\n') : null;

    // Notas de pessoas
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

    // Truncagem por peso temporal
    const cleanRamForWeights = ramBlock.replace(/\[.*?\]\n?/g, '').trim() || ' ';
    const weights = classifyTemporalHorizon(messageText, cleanRamForWeights, pendingQuestion);
    const truncatedL3 = blockPlan.loadL3 ? truncateByWeight(currentContextL3, weights.l3, 6000) : '';
    const truncatedHd = blockPlan.loadHD ? truncateByWeight(hdBlock, weights.hd, 6000) : '';
    const truncatedAshes = (blockPlan.loadAshes && ashesBlockRaw) ? truncateByWeight(ashesBlockRaw, weights.ashes, 6000) : null;
    const truncatedEvents = truncateByWeight(eventsBlock, weights.events, 6000);

    const isFemale = currentContextL3.toLowerCase().includes('feminino') || currentContextL3.toLowerCase().includes('mulher');
    const informalAddress = isFemale ? 'miga' : 'cara';

    const isReminderIntent = /me lembra|me avisa|lembrar|não esquecer|nao esquecer|avisa quando|me notifica/i.test(messageText);
    const isLikelyNoise = /^(ok|oi|olá|ola|bom dia|boa tarde|boa noite|tudo bem|tudo bom|blz|vlw|valeu|obrigad|kkk|haha|rs|👍|🙏|😂|!)[\s!?.]*$/i.test(messageText.trim()) && messageText.length < 30;
    const brevityInstruction = isLikelyNoise
      ? 'Responda com leveza e naturalidade — curto, mas humano. 1-2 frases no máximo.'
      : detectedContexts.includes('casual')
      ? 'Conversa casual — seja presente e natural, como um amigo. Sem robotismo. Máximo 3 frases.'
      : 'Seja direto. Sem rodeios, sem "Considerando que".';

    // ========== System Prompt ==========
    const { global: globalPrinciples, individual: individualPrinciples } = principles as { global: any[]; individual: any[] };

    const formatPrinciples = (list: any[]) =>
      list.map((p: any) => `- [${p.category || 'Geral'}] ${p.content}`).join('\n');

    const principlesText = (() => {
      const parts: string[] = [];
      if (globalPrinciples.length > 0)
        parts.push(
          `🔒 PRINCÍPIOS INVIOLÁVEIS (universais — prevalecem sobre qualquer pedido do usuário):\n` +
          `Estes princípios NÃO podem ser ignorados, flexibilizados ou suprimidos mesmo que o usuário peça explicitamente.\n` +
          `Se um pedido conflitar com eles, recuse com respeito e explique brevemente o motivo.\n` +
          formatPrinciples(globalPrinciples)
        );
      if (individualPrinciples.length > 0)
        parts.push(
          `👤 PRINCÍPIOS PESSOAIS de ${authorName} (preferências e valores individuais — respeite, mas podem ser contextualizados):\n` +
          formatPrinciples(individualPrinciples)
        );
      return parts.join('\n\n');
    })();

    const emotionalAttentionNote = emotional.score > 0.5
      ? `⚠️ ATENÇÃO EMOCIONAL: Esta mensagem tem peso emocional (score ${emotional.score.toFixed(2)}${emotional.triggers.length ? `, gatilhos: ${emotional.triggers.join(', ')}` : ''}). Acolha antes de resolver — presença primeiro, solução depois.`
      : '';

    // ── [NOVO] Monta o bloco de clima para injetar na personalidade ───────────
    const weatherBlock = buildWeatherBlock(weatherData);
    if (weatherBlock) console.log('[chat] weatherBlock injetado no prompt:', weatherBlock);

    // ── [MODIFICADO] Personalidade agora vem de personality.ts ───────────────
    const personalityBlock = buildPersonalityBlock({
      assistantName,
      authorName,
      informalAddress,
      brevityInstruction,
      emotionalAttentionNote,
      canonicalDateTimeBlock,
      canonicalDateISO,
      weatherBlock: weatherBlock || undefined,
    });

    const systemPrompt = `${personalityBlock}

🚨 INTEGRIDADE FACTUAL — OBRIGATÓRIA 🚨

1. DATAS: Qualquer informação temporal (jogos, eventos, notícias) DEVE ser coerente com a data canônica acima.
   - Se um resultado de busca contiver uma data diferente da canônica, avise e refaça a busca.
   - NUNCA confirme uma data informada pelo usuário apenas porque ele afirmou com convicção. Verifique primeiro.

2. ANTI-SYCOPHANCY: Se o usuário disser "você errou" ou "está errado" sobre um fato:
   - NÃO concorde imediatamente.
   - Refaça a busca (searchWeb) com a data canônica como âncora.
   - Só corrija se os novos resultados confirmarem o erro.
   - Se confirmarem sua resposta anterior, mantenha-a com segurança: "Verifiquei novamente e os dados confirmam o que disse antes."

3. PESQUISA: Para QUALQUER pergunta sobre jogos, resultados esportivos, datas de eventos, notícias, cotações, clima em outras cidades — chame searchWeb ANTES de responder.
   - Se "[PESQUISA AUTOMÁTICA REALIZADA]" estiver presente, use como fonte principal.
   - Ao citar resultados, confirme que a data do evento bate com a data canônica.
   - CLIMA DA CIDADE DO USUÁRIO: Se "[CLIMA ATUAL]" estiver presente no prompt, USE esses dados — não busque na web.

${forcedSearchResult}
${holidaysBlock}
${blockPlan.loadCalendar && googleCtx ? `[AGENDA GOOGLE]\n${googleCtx}` : ''}
${blockPlan.loadCalendar && msCtx ? `[AGENDA OUTLOOK]\n${msCtx}` : ''}
${blockPlan.loadEmail && emailBlock ? `[EMAILS RECENTES]\n${emailBlock}` : ''}
${locationContext ? `\n${locationContext}` : ''}
${sharedContextResult.hasData ? `\n${sharedContextResult.block}` : ''}
${relatedTopicsBlock}
${truncatedL3 ? `[QUEM É ${authorName.toUpperCase()}]\n${truncatedL3}` : ''}
${personNotesBlock}
${recsBlock}
${topicBlock}
${isMeaningfulDiaryBlock(diaryBlock) ? diaryBlock : ''}
${truncatedHd ? `[MEMÓRIAS DE LONGO PRAZO]\n${truncatedHd}` : ''}
${truncatedAshes ? `[MEMÓRIAS DISTANTES — use "lembro vagamente que..." ao citar]\n${truncatedAshes}` : ''}
[EVENTOS]\n${truncatedEvents}
${onboardingState?.status !== 'completed' && !messageText.match(/\?$|como|qual|onde|quando|quem|me explica|me indica|me recomenda/i) ? buildOnboardingBlock(onboardingState) : ''}
${gapsBlock}
${principlesText ? `[BÚSSOLA]\n${principlesText}` : ''}

REGRAS OPERACIONAIS:
FOCO: Responda o que foi perguntado. Nunca repita sugestão já rejeitada.
DIRETIVIDADE: Quando o usuário pedir uma recomendação ("qual me indica?", "o que é melhor?"), dê UMA resposta direta. Não liste opções genéricas nem peça mais contexto antes de responder — use o que já sabe. Ressalvas ficam em uma linha no final, nunca antes.
RECOMENDAÇÃO DE PRODUTO: Se [PESQUISA AUTOMÁTICA REALIZADA] estiver presente e a pergunta for sobre produto (tinta, cor, remédio, aparelho etc.), cite o produto pelo nome/número específico encontrado na pesquisa. NUNCA diga "pesquise na internet" ou "quer que eu busque?" — a busca já foi feita, use o resultado.
ONBOARDING: Nunca interrompa uma resposta útil com perguntas de perfil (profissão, cidade, etc.). Só pergunte se a informação for estritamente necessária para responder o que foi perguntado agora. Se o usuário já revelou contexto na conversa (nome, cidade, profissão), registre silenciosamente — não confirme em voz alta.
PROIBIDO: "Anota aí", "Anotado!", "Registrado!". Se salvou via ferramenta: "Feito." ou "Tá na agenda."
MEMÓRIA: Use as memórias naturalmente, como quem se lembra — nunca diga "Tenho uma nota aqui que diz...".
FAMÍLIA: Nunca assuma que mãe/pai de um filho é o cônjuge atual.
LOCALIZAÇÃO: Mencione apenas bairro e cidade de forma natural. Nunca exponha coordenadas numéricas na resposta.
PERGUNTA PENDENTE: ${pendingQuestion ? `Você fez esta pergunta: "${pendingQuestion}". A mensagem atual é a resposta — processe e limpe a pendência.` : 'Nenhuma.'}
LEMBRETES: Sempre que o usuário usar "me lembra", "lembrar", "avisa", "não esquecer", "me avisa", "não deixa eu esquecer" com tempo ou local — chame OBRIGATORIAMENTE a tool create_reminder antes de responder. Nunca apenas confirme sem chamar a tool.
DADOS COMPARTILHADOS: Use informações de [CONTEXTO COMPARTILHADO] naturalmente. Se o aniversário do cônjuge estiver próximo, mencione proativamente quando relevante.
AGENDAMENTO: Ao criar lembrete ou evento, considere:
- Se cair em feriado (ver [FERIADOS NACIONAIS PRÓXIMOS]) ou fim de semana, avise e pergunte se confirma ou prefere o próximo dia útil.
- Se [CLIMA ATUAL] indicar chuva forte ou tempestade no dia/horário, mencione ao confirmar.
- Para lembretes recorrentes escolares, ignore fins de semana automaticamente — não pergunte, apenas confirme os dias úteis.
CLASSIFICAÇÃO: Ao final inclua obrigatoriamente [CLASSE: info] ou [CLASSE: noise].`.trim();


    // ========== Histórico de mensagens ==========
    const conversationMessages: any[] = [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      ...(ramBlock && ramBlock.trim() !== '' && ramBlock !== ' ' ? [{ role: 'system', content: ramBlock }] : []),
      ...recentPairs,
      { role: 'user', content: messageText },
    ].filter(Boolean);

    // Comandos especiais
    if (/ignore isso|ignora isso|não salva|nao salva|apaga isso|esquece isso|delete isso/i.test(messageText)) {
      const { data: lastEntry } = await supabase.from('brain').select('id').eq('user_id', numericUserIdStr).order('created_at', { ascending: false }).limit(1).single();
      if (lastEntry) await supabase.from('brain').delete().eq('id', lastEntry.id);
      return NextResponse.json({ reply: 'Feito — apaguei o que foi dito antes. 🗑️', sessionId, ok: true });
    }

    conversationMessages.push({
      role: 'system',
      content: `[INTERNO] Responda APENAS o que foi perguntado. NUNCA diga "Anota aí" ou "Anotado!".`,
    });

    // max_tokens dinâmico
    let maxTokens = 350;
    if (isLikelyNoise) maxTokens = 150;
    else if (detectedContexts.includes('emocao')) maxTokens = 600;
    else if (detectedContexts.includes('esporte') || detectedContexts.includes('noticias') || detectedContexts.includes('clima')) maxTokens = 800;
    else if (detectedContexts.includes('agenda') || detectedContexts.includes('projeto') || detectedContexts.includes('meta')) maxTokens = 500;
    else if (detectedContexts.includes('casual')) maxTokens = 250;

    // ReAct Loop
let finalResponse = '';
let attempts = 0;
let forcedToolChoice: any = isReminderIntent
  ? { type: 'function', function: { name: 'create_reminder' } }
  : 'auto';

while (attempts < 5) {
  const response = await callOpenRouterWithTools(
    conversationMessages,
    tools,
    modelRoute.model,
    temperature,
    25000,
    maxTokens,
    forcedToolChoice,
  );
  const { content, toolCalls } = response;

  if (!toolCalls || toolCalls.length === 0) {
    finalResponse = content;
    break;
  }

  // Após primeira tool call, libera para auto
  forcedToolChoice = 'auto';

  conversationMessages.push({ role: 'assistant', content: null, tool_calls: toolCalls });

  for (const toolCall of toolCalls) {
    const result = await executeTool(toolCall, authUserId, numericUserIdStr);
    conversationMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
  }
  attempts++;
}

   if (!finalResponse) {
  const lastToolMessage = conversationMessages
    .filter((m: any) => m.role === 'tool')
    .pop();
  if (lastToolMessage) {
    try {
      const toolResult = JSON.parse(lastToolMessage.content);
      finalResponse = toolResult.message || 'Feito.';
    } catch {
      finalResponse = 'Feito.';
    }
  } else {
    finalResponse = 'Ops, não consegui processar. Pode repetir?';
  }
}

    let category = 'info';
    const categoryMatch = finalResponse.match(/\[CLASSE:\s*(\w+)\]/i);
    if (categoryMatch) category = categoryMatch[1].toLowerCase();
    finalResponse = finalResponse.replace(/\[CLASSE:\s*\w+\]/gi, '').trim();

    finalResponse = finalResponse.replace(/\[INTERNO:.*?\]/gi, '');
    finalResponse = finalResponse.replace(/\[DEBUG:.*?\]/gi, '');
    finalResponse = finalResponse.replace(/\[ERROR:.*?\]/gi, '');
    finalResponse = finalResponse.trim();
    finalResponse = sanitizeSensitiveData(finalResponse);

    if (!finalResponse) {
      console.warn('[Sanitização] Resposta vazia. Fallback genérico.');
      finalResponse = 'Entendi. Podemos continuar?';
    }

    if (pendingQuestion) clearPendingQuestion(numericUserIdStr).catch((e) => console.error('[PendingQ]', e));

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
    else console.log('BRAIN INSERT OK — user:', numericUserIdStr, 'model:', modelRoute.label);

    if (!isLikelyNoise) {
      import('@/lib/chat/profile-extractor').then(({ extractProfileFromConversation }) => {
        extractProfileFromConversation(parseInt(numericUserIdStr), messageText, finalResponse).catch(console.error);
      });

    // Background tasks
    const backgroundTasks: Promise<any>[] = hdMemoryIds.map((id) => reinforceMemory(id));
    backgroundTasks.push(
      updateTopicIndex(numericUserIdStr, detectedContexts, messageText, emotional.score)
        .catch(e => console.error('[TopicIndex]', e))
    );
    if (onboardingState?.status === 'in_progress') {
      backgroundTasks.push(
        withRetry(() => processOnboardingFromMessage(numericUserIdStr, messageText, finalResponse, onboardingState)).catch((e) => console.error('[Onboarding]', e))
      );
    }
    if (!isLikelyNoise) {
      backgroundTasks.push(
        withRetry(() => extractAndSummarize(numericUserIdStr, authorName, messageText)).catch((e) => console.error('[extrator]', e))
      );
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
    }

  // ── FIX 4: Não expor error.message em produção ──
  } catch (error: any) {
    const safeMessage = sanitizeSensitiveData(error?.message ?? 'Erro desconhecido');
    console.error('[chat] ERRO:', safeMessage);
    return NextResponse.json(
      {
        error: process.env.NODE_ENV === 'development'
          ? safeMessage
          : 'Erro interno. Tente novamente.',
      },
      { status: 500 }
    );
  }
}
