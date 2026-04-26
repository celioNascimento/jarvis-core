// app/api/chat/route.ts
// Motor V8.13.1 — Self-discovery + Meta-cognição + Promoção automática de padrões + Finanças

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
import { buildGapsBlock } from '@/lib/extractor';
import { buildRecommendationsBlock, buildTopicBlock } from '@/lib/extractor-jobs';
import { buildDiaryGoalsBlock } from '@/lib/diary';
import { runUnifiedExtractor } from '@/lib/chat/unified-extractor';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
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
import { buildPersonalityBlock } from '@/lib/chat/personality';
import { buildProfileBlock } from '@/lib/chat/profile-block';
import { promotePatternToPrinciple } from '@/lib/chat/pattern-promoter';
import { buildFinanceBlock } from '@/lib/finances/db'; // ✅ PATCH 1

export const maxDuration = 60;

// ========== SABEDORIA: ORÇAMENTO DE TOKENS ==========
const GLOBAL_MAX_CHARS = 12000;
const INTENT_BUDGETS: Record<string, { l3: number, hd: number, finance: number, events: number, ashes: number }> = {
  personal: { l3: 0.6, hd: 0.2, finance: 0.05, events: 0.1, ashes: 0.05 },
  factual:  { l3: 0.1, hd: 0.6, finance: 0.1,  events: 0.1, ashes: 0.1 },
  finance:  { l3: 0.1, hd: 0.1, finance: 0.7,  events: 0.1, ashes: 0.0 },
  focus:    { l3: 0.3, hd: 0.1, finance: 0.0,  events: 0.6, ashes: 0.0 },
  calendar: { l3: 0.1, hd: 0.1, finance: 0.0,  events: 0.8, ashes: 0.0 },
  email:    { l3: 0.2, hd: 0.1, finance: 0.1,  events: 0.6, ashes: 0.0 },
  reminder: { l3: 0.1, hd: 0.1, finance: 0.0,  events: 0.8, ashes: 0.0 },
  task:     { l3: 0.2, hd: 0.1, finance: 0.0,  events: 0.7, ashes: 0.0 },
  casual:  { l3: 0.2, hd: 0.1, finance: 0.0, events: 0.05, ashes: 0.0 },
  trivial: { l3: 0.05, hd: 0.0, finance: 0.0, events: 0.0, ashes: 0.0 },
};
// ====================================================


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
      console.warn('[Cache] Redis GET falhou:', (e as Error).message);
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
    timeZone: timezone, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const timeStr = now.toLocaleTimeString(locale, {
    timeZone: timezone, hour: '2-digit', minute: '2-digit',
  });
  return `${dateStr} às ${timeStr} (${timezone})`;
}

function getCurrentDateParts(timezone: string): { day: number; month: number; year: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, day: 'numeric', month: 'numeric', year: 'numeric',
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

function buildWeatherBlock(weather: Record<string, any> | null | undefined): string {
  if (!weather) return '';
  const parts: string[] = [];
  if (weather.city)             parts.push(weather.city);
  if (weather.temp != null)     parts.push(`${Math.round(weather.temp)}°C`);
  if (weather.condition)        parts.push(weather.condition);
  if (weather.humidity != null) parts.push(`Umidade ${weather.humidity}%`);
  if (weather.wind != null)     parts.push(`Vento ${weather.wind} km/h`);
  if (weather.feelsLike != null) parts.push(`Sensação ${Math.round(weather.feelsLike)}°C`);
  if (weather.forecast) {
    const forecastStr = Array.isArray(weather.forecast)
      ? weather.forecast.map((f: any) => f?.description || f?.condition || '').filter(Boolean).slice(0, 2).join(', ')
      : String(weather.forecast);
    if (forecastStr) parts.push(`Previsão: ${forecastStr}`);
  }
  return parts.join(' · ');
}

export function buildAgendaBlock(
  loadCalendar: boolean,
  googleCtx: string | null,
  msCtx: any,
  numericUserId: string,
): string {
  const parts: string[] = [];
 
  if (loadCalendar && googleCtx) {
    parts.push(`[AGENDA GOOGLE — somente leitura]\n${googleCtx}`);
  }
 
  if (loadCalendar && msCtx) {
    parts.push(`[AGENDA OUTLOOK — somente leitura]\n${msCtx}`);
  }
 
  if (loadCalendar) {
    parts.push(
      `[INSTRUÇÃO DE AGENDA]\n` +
      `A agenda PRÓPRIA do Lev é a jarvis.agenda. ` +
      `Ao salvar compromissos, use SEMPRE salvar_evento (jarvis.agenda). ` +
      `Os dados acima são apenas para consulta/leitura do Google/Outlook. ` +
      `NÃO confunda leitura de agenda com local de escrita.`
    );
  }
 
  return parts.join('\n\n');
}

export async function POST(req: NextRequest) {
  console.log('[chat] Iniciando — V8.13.1 (memória completa com dynamic guidelines e finanças)');
  try {
    console.time('[Performance] total');
    let messageText = '';
    let userEmail = '';
    let tempUserId = '';
    let clientSessionId: string | null = null;
    let userFirstName = 'Usuário';
    let location: { latitude: number; longitude: number } | null = null;
    let weatherData: Record<string, any> | null = null;

    // --- Parsing do request ---
    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const audioFile = formData.get('audio') as File | null;

      userEmail    = (formData.get('userEmail') as string) || (formData.get('email') as string) || '';
      tempUserId   = (formData.get('userId') as string) || (formData.get('user_id') as string) || '';
      clientSessionId = formData.get('sessionId') as string | null;
      userFirstName   = (formData.get('userFirstName') as string) || 'Usuário';

      const latField = formData.get('latitude') as string | null;
      const lngField = formData.get('longitude') as string | null;
      if (latField && lngField) location = { latitude: parseFloat(latField), longitude: parseFloat(lngField) };

      const weatherField = formData.get('weather') as string | null;
      if (weatherField) { try { weatherData = JSON.parse(weatherField); } catch { /* ignora */ } }

      if (!audioFile && !formData.get('message') && !formData.get('text'))
        return NextResponse.json({ error: 'Áudio ou texto obrigatório' }, { status: 400 });

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
      messageText     = body.message || body.text || '';
      userEmail       = body.userEmail || body.email || '';
      tempUserId      = body.userId || body.user_id || '';
      clientSessionId = body.sessionId || null;
      userFirstName   = body.userFirstName || body.user_first_name || 'Usuário';
      if (body.location?.latitude != null && body.location?.longitude != null)
        location = { latitude: body.location.latitude, longitude: body.location.longitude };
      if (body.weather && typeof body.weather === 'object') weatherData = body.weather;
    }

    if (messageText) messageText = sanitizeSensitiveData(messageText);

    if (!messageText && !location)
      return NextResponse.json({ error: 'message obrigatório' }, { status: 400 });
    if (!userEmail && !tempUserId)
      return NextResponse.json({ error: 'userEmail ou userId obrigatório' }, { status: 400 });

    // --- Lookup do usuário ---
    let userRecord: any = null;

    if (userEmail) {
      const { data, error } = await supabase
        .from('users')
        .select('id, nickname, current_context, assistant_name, timezone, pending_question, pending_context, auth_user_id')
        .eq('email', userEmail)
        .maybeSingle();
      if (error) console.error('[chat] Erro na busca por email:', error);
      userRecord = data;
    }

    if (!userRecord && tempUserId) {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tempUserId);
      if (isUUID) {
        const { data, error } = await supabase
          .from('users')
          .select('id, nickname, current_context, assistant_name, timezone, pending_question, pending_context, auth_user_id')
          .eq('auth_user_id', tempUserId)
          .maybeSingle();
        if (error) console.error('[chat] Erro na busca por auth_user_id:', error);
        userRecord = data;
      }
    }

    if (!userRecord) {
      console.error('[chat] USUÁRIO NÃO ENCONTRADO! email:', userEmail, 'userId:', tempUserId);
      if (process.env.NODE_ENV === 'development')
        return NextResponse.json({ error: 'Usuário não encontrado.', debug: { email: userEmail, userId: tempUserId } }, { status: 404 });
      return NextResponse.json({ error: 'Usuário não encontrado. Faça login novamente.' }, { status: 404 });
    }

    const numericUserIdStr = String(userRecord.id);
    if (!numericUserIdStr || isNaN(Number(numericUserIdStr))) throw new Error('Invalid numeric user ID');

    let authUserId: string | null = userRecord.auth_user_id || null;
    if (!authUserId && tempUserId) {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tempUserId);
      if (isUUID) authUserId = tempUserId;
    }
    if (!authUserId) {
      console.warn('[chat] authUserId não resolvido');
      authUserId = numericUserIdStr;
    }

    const authorName        = userRecord.nickname || userFirstName;
    const assistantName     = userRecord.assistant_name || 'Lev';
    const userTimezone      = userRecord.timezone || 'America/Sao_Paulo';
    const currentContextL3  = userRecord.current_context || 'Sem dossiê ainda.';
    const pendingQuestion   = userRecord.pending_question || null;

    const sessionId = clientSessionId || (await getOrCreateSession(numericUserIdStr));

    const canonicalDateTimeBlock = buildDateTimeBlock(userTimezone);
    const { day, month, year }   = getCurrentDateParts(userTimezone);
    const canonicalDateISO = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    // Localização
    let locationContext = '';
    if (location) {
      const { latitude, longitude } = location;
      const latMasked = parseFloat(latitude.toFixed(2));
      const lngMasked = parseFloat(longitude.toFixed(2));

      let lastKnownLocation: { city: string; state: string } | null = null;

      const { data: savedLoc } = await supabase
        .from('user_locations')
        .select('city, state, latitude, longitude, last_updated')
        .eq('user_id', numericUserIdStr)
        .maybeSingle();
      if (savedLoc?.city) {
        lastKnownLocation = { city: savedLoc.city, state: savedLoc.state };
      }

      const endereco = await checkProximidade(latitude, longitude, numericUserIdStr);
      locationContext = endereco;

      await supabase.from('config').upsert(
        { key: `last_location_${numericUserIdStr}`, value: JSON.stringify({ lat_approx: latMasked, lng_approx: lngMasked, endereco, ts: Date.now() }) },
        { onConflict: 'key' }
      );

      const alertaGeo = await verificarAlertasDeProximidade(authUserId, latitude, longitude);
      if (alertaGeo.temAlerta) return NextResponse.json({ reply: alertaGeo.mensagem, sessionId, ok: true });
      if (!messageText) messageText = '[Enviou Localização]';
    }

    // ========== 1. Classificação rápida ==========
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

          if (error) console.error('[Memória HD] Erro na RPC:', error);
          else if (search?.length) {
            hdSearchResults = search.map((r: any) => ({
              similarity: r.similarity,
              emotional_weight: r.emotional_weight ?? 0.5,
              summary: r.summary,
              id: r.id,
            }));
            hdBlock = hdSearchResults.filter(r => !r.summary?.startsWith('[CINZA]')).map(r => r.summary).join('\n---\n');
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

    // ========== 3. Detecção de shift ==========
    const shiftDetected = !isTrivialEarly ? await detectTopicShiftWithL4(numericUserIdStr, detectedContexts) : false;

    // ========== 4. Histórico ==========
    const { data: historySession } = await supabase
      .schema('jarvis')
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
            
      const pairsToUse = historySession.slice(0, 12);
      recentPairs = [...pairsToUse].reverse().flatMap((h: any) => [
        { role: 'user' as const, content: h.content },
        { role: 'assistant' as const, content: trimAssistantReply(h.metadata?.ai_reply || '') },
      ]);
      if (shiftDetected && historySession.length > 1) {
        const validHistory = historySession.filter(h => h.metadata?.ai_reply);
        if (validHistory.length > 1) ramBlock = `[CONTEXTO ANTERIOR RESUMIDO]\n${compressToSummary(validHistory.slice(1))}`;
      }
    } else {
      if (historySession && historySession.length > 0) {
        ramBlock = [...historySession].reverse().map(
          (h: any) => `${authorName}: ${h.content}\n${assistantName}: ${trimAssistantReply(h.metadata?.ai_reply || '')}`
        ).join('\n\n');
      } else {
        const semanticBlock = await semanticRamCompression(historySession || [], numericUserIdStr, messageText, queryEmbedding ?? undefined);
        ramBlock = semanticBlock || (hdBlock ? `[Contexto anterior consolidado]\n${hdBlock}` : ' ');
      }
      if (ramBlock.length > RAM_MAX_CHARS) ramBlock = ramBlock.slice(-RAM_MAX_CHARS);
    }

    // ========== 5. Emotional Score ==========
    const emotional = await computeEmotionalScore(messageText, numericUserIdStr, hdSearchResults, ramBlock);
    console.log('[Emotional] Score:', emotional.score, 'Traj:', emotional.trajectory);

    // ========== 6. Segunda busca HD condicional ==========
    if (emotional.score > 0.6 && queryEmbedding && hdSearchResults.length < 6) {
      try {
        const { data: extraSearch } = (await supabase.rpc('match_memories', {
          query_embedding: queryEmbedding, match_threshold: 0.12, match_count: 12,
        })) as { data: any[] | null };
        if (extraSearch?.length) {
          const existingIds = new Set(hdMemoryIds);
          const extras = extraSearch.filter((r: any) => !existingIds.has(r.id));
          if (extras.length) {
            hdSearchResults.push(...extras.map((r: any) => ({ similarity: r.similarity, emotional_weight: r.emotional_weight ?? 0.5, summary: r.summary, id: r.id })));
            hdBlock = hdSearchResults.filter(r => !r.summary?.startsWith('[CINZA]')).map(r => r.summary).join('\n---\n');
            hdMemoryIds = hdSearchResults.map(r => r.id);
          }
        }
      } catch (err) { console.error('[Memória HD] Erro na segunda busca:', err); }
    }

    // ========== 7. Tópico emocional ==========
    let topicEmotionalDimension: number | undefined;

    // ========== 8. Cargas contextuais (sem financeBlock, que será buscado depois) ==========
    const [
      events,
      ashes,
      principles,
      childrenData,
      personNotesData,
      onboardingState,
      topicEmotionalDimValue,
      sharedContextResult,
      profileBlock,
      dynamicGuidelines,
    ] = await Promise.all([
      // ── events ────────────────────────────────────────────────
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
      // ── ashes ─────────────────────────────────────────────────
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
      // ── principles ────────────────────────────────────────────
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
      // ── childrenData — mantido para o filtro de personNotesBlock ──
      (async () => {
        const key = `children_${numericUserIdStr}`;
        const cached = await cache.get<any[]>(key);
        if (cached) return cached;
        const { data } = await supabase
          .from('children')
          .select('name, nickname, lev_notes')
          .eq('parent_id', numericUserIdStr);
        const val = data || [];
        await cache.set(key, val);
        return val;
      })(),
      // ── personNotesData ───────────────────────────────────────
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
      // ── onboardingState ───────────────────────────────────────
      (async () => {
        const key = `onboarding_${numericUserIdStr}`;
        const cached = await cache.get(key);
        if (cached) return cached;
        const { data } = await supabase
          .from('onboarding_progress')
          .select('*')
          .eq('user_id', numericUserIdStr)
          .maybeSingle();
        const state = data || await getOrCreateOnboardingStatePersistent(numericUserIdStr);
        await cache.set(key, state, 60000);
        return state;
      })(),
      // ── topicEmotionalDimValue ────────────────────────────────
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
      // ── sharedContextResult ───────────────────────────────────
      (async () => {
        const key = `shared_ctx_${numericUserIdStr}_${detectedContexts.slice(0, 3).join('_')}`;
        const cached = await cache.get<{ block: string; hasData: boolean }>(key);
        if (cached) return cached;
        const result = await buildSharedContextBlock(authUserId!, numericUserIdStr, detectedContexts, authorName);
        await cache.set(key, result, 20000);
        return result;
      })(),
      // ── profileBlock ──────────────────────────────────────────
      (async () => {
        const key = `profile_block_${numericUserIdStr}_${detectedContexts.slice(0, 3).sort().join('_')}`;
        const cached = await cache.get<string>(key);
        if (cached) return cached;
        const block = await buildProfileBlock({
          userId: Number(numericUserIdStr),
          authUserId: authUserId!,
          authorName,
          contexts: detectedContexts,
        });
        await cache.set(key, block, 60000);
        return block;
      })(),
      // ── dynamicGuidelines ─────────────────────────────────
      (async () => {
        const key = `dynamic_guidelines_${numericUserIdStr}`;
        const cached = await cache.get<string>(key);
        if (cached !== null) return cached;
        const { data } = await supabase
          .schema('jarvis')
          .from('dynamic_guidelines')
          .select('content')
          .eq('active', true)
          .or(`user_id.eq.${numericUserIdStr},scope.eq.global`)
          .order('created_at', { ascending: false })
          .limit(10);
        const val = data?.length
          ? data.map((g: any) => `- ${g.content}`).join('\n')
          : '';
        await cache.set(key, val, 60000);
        return val;
      })(),
    ]);

    topicEmotionalDimension = topicEmotionalDimValue;

    // ========== 9. Roteamento e blockPlan ==========
    const isLikelyNoise = /^(ok|oi|olá|ola|bom dia|boa tarde|boa noite|tudo bem|tudo bom|blz|vlw|valeu|obrigad|kkk|haha|rs|👍|🙏|😂|!)[\s!?.]*$/i.test(messageText.trim()) && messageText.length < 30;
    const modelRoute = routeModel(detectedContexts, emotional.score, topicEmotionalDimension);
    const temperature = getTemperature(detectedContexts);

  function classifyIntent(message: string, contexts: ContextType[], isNoise: boolean, isTrivial: boolean): string {
  const m = message.toLowerCase();
  if (isTrivial) return 'trivial';
  if (isNoise || contexts.includes('casual')) return 'casual';
  if (/foco|tdah|sobrecarregado|procrastinando|travado|paralisado|por onde começo|quebrar tarefa/.test(m)) return 'focus';
  if (/agenda|reunião|compromisso|semana|calendário/.test(m)) return 'calendar';
  if (/email|mensagem|caixa|inbox|respondeu/.test(m)) return 'email';
  if (/lembra|me avisa|não esquecer|lembrete|avisa/.test(m)) return 'reminder';
  if (/como fazer|o que é|diferença|explica|qual é|por que|como funciona/.test(m)) return 'factual';
  if (/me sinto|tô |estou |foi difícil|desabafar|cansado|ansioso/.test(m)) return 'personal';
  if (/faz|cria|gera|escreve|monta|lista|resume/.test(m)) return 'task';
  return 'personal';
}

    const intent = classifyIntent(messageText, detectedContexts, isLikelyNoise, isTrivialEarly);

      
    const budget = INTENT_BUDGETS[intent] || INTENT_BUDGETS.personal;

    const blockPlan = {
      ...planContextualBlocks(detectedContexts),
      loadDiary:           intent === 'personal' || intent === 'focus',
      loadGaps:            intent === 'personal',
      loadRecommendations: intent === 'personal',
      loadEmail:           intent === 'email',
      loadCalendar:        ['calendar', 'reminder'].includes(intent),
      loadTopics:          !['factual', 'task', 'focus', 'casual', 'trivial'].includes(intent),
      // ✅ PATCH 3: loadFinances
      loadFinances: detectedContexts.includes('financas') || intent === 'finance',

      // Limites dinâmicos calculados
      l3Limit: Math.floor(GLOBAL_MAX_CHARS * budget.l3),
      hdLimit: Math.floor(GLOBAL_MAX_CHARS * budget.hd),
      financeLimit: Math.floor(GLOBAL_MAX_CHARS * budget.finance),
      eventsLimit: Math.floor(GLOBAL_MAX_CHARS * budget.events),
      ashesLimit: Math.floor(GLOBAL_MAX_CHARS * budget.ashes),
    };
    console.log('[chat] contexts:', detectedContexts, '| model:', modelRoute.label, '| intent:', intent, '| L3 Limit:', blockPlan.l3Limit);

    
        // ✅ PATCH 2: Busca com limite de Sabedoria
    let financeBlock = '';
    if (blockPlan.loadFinances && blockPlan.financeLimit > 0) {
      const key = `finance_block_${numericUserIdStr}`;
      const cached = await cache.get<string>(key);
      if (cached !== null) {
        financeBlock = truncateByWeight(cached, 1.0, blockPlan.financeLimit);
      } else {
        let fullFinance = await buildFinanceBlock(Number(numericUserIdStr), authUserId!).catch(() => '');
        financeBlock = truncateByWeight(fullFinance, 1.0, blockPlan.financeLimit);
        await cache.set(key, financeBlock, 120000); // 2 min
      }
    }


    // ========== Ajuste adaptativo baseado no histórico do critic ==========
    let adaptiveTemperatureOffset = 0;
    let adaptiveMaxTokensMultiplier = 1.0;
    try {
      const criticHistoryKey = `critic_history_${numericUserIdStr}`;
      const criticHistory = await redis.get<any[]>(criticHistoryKey) ?? [];
      if (criticHistory.length >= 3) {
        const recent = criticHistory.slice(-5);
        const avgOverall   = recent.reduce((s, c) => s + (c.overall ?? 0.7), 0) / recent.length;
        const flagCounts   = recent.reduce((acc: Record<string,number>, c) => { acc[c.flag] = (acc[c.flag] || 0) + 1; return acc; }, {});
        const dominantFlag = Object.entries(flagCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

        if (dominantFlag === 'verbose')       adaptiveMaxTokensMultiplier = 0.8;
        else if (dominantFlag === 'cold')     adaptiveTemperatureOffset   = 0.15;
        else if (dominantFlag === 'missed_emotion') adaptiveTemperatureOffset = 0.1;
        else if (dominantFlag === 'off_topic') adaptiveMaxTokensMultiplier = 0.9;

        if (avgOverall < 0.5) adaptiveTemperatureOffset = Math.max(adaptiveTemperatureOffset, 0.1);

        if (adaptiveTemperatureOffset !== 0 || adaptiveMaxTokensMultiplier !== 1.0)
          console.log('[AdaptiveCritic] offset_temp:', adaptiveTemperatureOffset, '| tokens_mult:', adaptiveMaxTokensMultiplier, '| dominant_flag:', dominantFlag);
      }
    } catch (e) {
      // silencioso
    }

    // ========== 10. Pesquisa forçada ==========
    const shouldSearch = shouldForceSearch(messageText, detectedContexts);
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

    // ========== 11. Blocos condicionais ==========
    const [gapsBlock, topicBlock, diaryBlock, recsBlock, relatedTopicsBlock] = await Promise.all([
      blockPlan.loadGaps
        ? (async () => {
            const key = `gaps_${numericUserIdStr}_${Buffer.from(messageText.slice(0, 50)).toString('base64')}`;
            let val = await cache.get<string>(key);
            if (!val) { val = await buildGapsBlock(numericUserIdStr, messageText); await cache.set(key, val, 60000); }
            return val;
          })() : Promise.resolve(''),
      blockPlan.loadTopics
        ? (async () => {
            const key = `topic_${numericUserIdStr}_${Buffer.from(messageText.slice(0, 50)).toString('base64')}`;
            let val = await cache.get<string>(key);
            if (!val) { val = await buildTopicBlock(numericUserIdStr, messageText).catch(() => ''); await cache.set(key, val, 60000); }
            return val;
          })() : Promise.resolve(''),
      blockPlan.loadDiary
        ? (async () => {
            const key = `diary_${numericUserIdStr}`;
            let val = await cache.get<string>(key);
            if (!val) { val = await buildDiaryGoalsBlock(numericUserIdStr).catch(() => ''); await cache.set(key, val, 60000); }
            return val;
          })() : Promise.resolve(''),
      blockPlan.loadRecommendations
        ? (async () => {
            const key = `recs_${numericUserIdStr}_${Buffer.from(messageText.slice(0, 50)).toString('base64')}`;
            let val = await cache.get<string>(key);
            if (!val) { val = await buildRecommendationsBlock(numericUserIdStr, messageText).catch(() => ''); await cache.set(key, val, 60000); }
            return val;
          })() : Promise.resolve(''),
      blockPlan.loadTopics
        ? (async () => {
            const key = `related_${numericUserIdStr}_${detectedContexts[0] || 'casual'}`;
            const cached = await cache.get<string>(key);
            if (cached) return cached;
            const val = await getRelatedTopics(numericUserIdStr, detectedContexts[0] || 'casual');
            await cache.set(key, val, 30000);
            return val;
          })() : Promise.resolve(''),
    ]);

    // ========== 12. Calendários e emails ==========
    const backgroundTasks: Promise<any>[] = [];

    let googleCtx: string | null = null;
    let msCtx: any = null; 
    
    if (blockPlan.loadCalendar) {
      const { data: dbContext, error: dbError } = await supabase.rpc('get_calendar_context_for_jarvis', {
        p_user_id: Number(numericUserIdStr),
        p_days: 7
      });

      if (!dbError && dbContext) {
        googleCtx = dbContext; 
      } else if (dbError) {
        console.error('[Calendar DB Error]:', dbError.message);
      }

      backgroundTasks.push(
        (async () => {
          try {
            const mod = await import('@/lib/google');
            if (typeof mod.syncGoogleCalendarToLev === 'function') {
              await mod.syncGoogleCalendarToLev(BigInt(numericUserIdStr));
            }
          } catch (e: any) {
            console.warn('[Sync Background] função não disponível:', e.message);
          }
        })()
      );
    }

    let emailBlock = null;
    
    let holidaysBlock = '';
    const needsHolidays = detectedContexts.includes('agenda') || detectedContexts.includes('evento') || detectedContexts.includes('familia');
    if (needsHolidays) {
      try {
        const key = `holidays_${canonicalDateISO}`;
        let holidays = await cache.get<any[]>(key);
        if (!holidays) { holidays = await getUpcomingHolidays(10); await cache.set(key, holidays, 3600000); }
        if (holidays.length > 0)
          holidaysBlock = `\n[FERIADOS NACIONAIS PRÓXIMOS]\n${holidays.map(h => `- ${h.name}: ${new Date(h.date).toLocaleDateString('pt-BR')}`).join('\n')}`;
      } catch (err) { console.error('[Holidays] Erro:', err); }
    }

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
    const eventsBlock = activeEvents.length > 0
      ? [
          upcomingEvents.length > 0 ? `🔴 NOS PRÓXIMOS DIAS:\n${upcomingEvents.map((e) => `  - ${e.title}: ${e.event_date}${e.notes ? ` (${e.notes})` : ''}`).join('\n')}` : null,
          highRelevanceEvents.length > 0 ? `🟡 IMPORTANTES:\n${highRelevanceEvents.map((e) => `  - ${e.title}: ${e.event_date}`).join('\n')}` : null,
        ].filter(Boolean).join('\n\n')
      : 'Nenhum evento cadastrado.';

    const ashesBlockRaw = ashes.length > 0 ? ashes.map((a: any) => a.ash_summary).join('\n') : null;

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

    const cleanRamForWeights = ramBlock.replace(/\[.*?\]\n?/g, '').trim() || ' ';
    const weights = classifyTemporalHorizon(messageText, cleanRamForWeights, pendingQuestion);
    // Aplicação da Sabedoria: Limites ditados pelo blockPlan em vez de fixos
    const truncatedL3     = blockPlan.loadL3 ? truncateByWeight(currentContextL3, weights.l3, blockPlan.l3Limit) : '';
    const truncatedHd     = blockPlan.loadHD ? truncateByWeight(hdBlock, weights.hd, blockPlan.hdLimit) : '';
    const truncatedAshes  = (blockPlan.loadAshes && ashesBlockRaw) ? truncateByWeight(ashesBlockRaw, weights.ashes, blockPlan.ashesLimit) : null;
    const truncatedEvents = truncateByWeight(eventsBlock, weights.events, blockPlan.eventsLimit);

    const isFemale = currentContextL3.toLowerCase().includes('feminino') || currentContextL3.toLowerCase().includes('mulher');
    const informalAddress = isFemale ? 'miga' : 'cara';

    const isReminderIntent = /me lembra|me avisa|lembrar|não esquecer|nao esquecer|avisa quando|me notifica/i.test(messageText);
    
    const brevityInstruction = isLikelyNoise
      ? 'Responda com leveza e naturalidade — curto, mas humano. 1-2 frases no máximo.'
      : detectedContexts.includes('casual')
      ? 'Conversa casual — seja presente e natural, como um amigo. Sem robotismo. Máximo 3 frases.'
      : 'Seja direto. Sem rodeios, sem "Considerando que".';

    // ========== System Prompt ==========
    const { global: globalPrinciples, individual: individualPrinciples } = principles as { global: any[]; individual: any[] };
    const formatPrinciples = (list: any[]) => list.map((p: any) => `- [${p.category || 'Geral'}] ${p.content}`).join('\n');
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

    const weatherBlock = buildWeatherBlock(weatherData);
    if (weatherBlock) console.log('[chat] weatherBlock injetado:', weatherBlock);

    const personalityBlock = buildPersonalityBlock({
      assistantName, authorName, informalAddress, brevityInstruction,
      emotionalAttentionNote, canonicalDateTimeBlock, canonicalDateISO,
      weatherBlock: weatherBlock || undefined,
    });

    const systemPrompt = `${personalityBlock}

🚨 INTEGRIDADE FACTUAL — OBRIGATÓRIA 🚨

1. DATAS: Qualquer informação temporal DEVE ser coerente com a data canônica acima.
   - Nunca confirme uma data informada pelo usuário sem verificar.

2. ANTI-SYCOPHANCY: Se o usuário disser "você errou":
   - NÃO concorde imediatamente.
   - Refaça a busca com a data canônica como âncora.
   - Só corrija se os novos resultados confirmarem o erro.

3. PESQUISA: Para jogos, resultados, datas, notícias, cotações, clima em outras cidades — chame searchWeb ANTES de responder.
   - CLIMA DA CIDADE DO USUÁRIO: Se "[CLIMA ATUAL]" estiver presente, USE esses dados.
   - REGRA DE BUSCA: NUNCA faça buscas genéricas ("Dra. Carol"). Sempre enriqueça a query de busca com as informações que você tem na RAM (ex: "Dra. Caroline dentista Arthur Thomas 1100 Rolândia").
   
${forcedSearchResult}
${holidaysBlock}
${buildAgendaBlock(blockPlan.loadCalendar, googleCtx, msCtx, numericUserIdStr)}
${blockPlan.loadFinances && financeBlock ? `[FINANÇAS]\n${financeBlock}` : ''}
${blockPlan.loadEmail && emailBlock ? `[EMAILS RECENTES]\n${emailBlock}` : ''}
${locationContext ? `\n${locationContext}` : ''}
${sharedContextResult.hasData ? `\n${sharedContextResult.block}` : ''}
${relatedTopicsBlock}
${truncatedL3 ? `[QUEM É ${authorName.toUpperCase()}]\n${truncatedL3}` : ''}
${profileBlock}
${personNotesBlock}
${recsBlock}
${topicBlock}
${isMeaningfulDiaryBlock(diaryBlock) ? diaryBlock : ''}
${truncatedHd ? `[MEMÓRIAS DE LONGO PRAZO]\n${truncatedHd}` : ''}
${truncatedAshes ? `[MEMÓRIAS DISTANTES — use "lembro vagamente que..." ao citar]\n${truncatedAshes}` : ''}
[EVENTOS]\n${truncatedEvents}
${onboardingState?.status !== 'completed' ? buildOnboardingBlock(onboardingState) : ''}
${gapsBlock}
${principlesText ? `[BÚSSOLA]\n${principlesText}` : ''}
${dynamicGuidelines ? `[DIRETRIZES DA INSTÂNCIA ATIVA]\n${dynamicGuidelines}` : ''}
${intent === 'focus' ? `\n[MODO SUPORTE EXECUTIVO ATIVADO]\nO usuário demonstrou sinais de paralisia, TDAH ou sobrecarga. SEJA EXTREMAMENTE DIRETIVO. Sem preâmbulos. Fale frases curtas. Dê apenas o PRÓXIMO PASSO IMEDIATO. Sugira a ferramenta 'quebrar_tarefa' se for algo complexo.` : ''}


REGRAS OPERACIONAIS:
FOCO: Responda o que foi perguntado. Nunca repita sugestão já rejeitada.
MODO DE RESPOSTA:
- Pergunta factual/procedural ("como fazer X", "o que é Y", "diferença entre A e B"):
  Responda imediatamente com a resposta. Sem preâmbulo, sem recap da pergunta.
  Se couber em 2 frases, use 2 frases. Se precisar de passos, lista numerada curta.
  Contexto pessoal entra naturalmente se relevante — nunca anunciado.
- Pergunta técnica: começa pela solução, explica o porquê só se necessário.
- Pergunta pessoal/reflexiva: usa memórias naturalmente, tom próximo.
- Desabafo/observação sem pedido implícito ("acho que vai doer", "tô cansado", "que dia pesado"):
  Acolha em 1 frase. Não pergunte nada, não ofereça ação.
  Ex: "Torço pra correr tudo bem." — não: "Quer que eu te lembre de algo?"
- Pergunta ambígua: resolve pela interpretação mais provável. Se interpretou diferente, menciona ao final em uma linha — não antes de responder.
PROIBIDO em qualquer resposta:
- Preâmbulos ("Claro!", "Boa pergunta!", "Com certeza!", "Entendido!")
- Resumir o que o usuário acabou de dizer antes de responder
- Múltiplas perguntas de volta — no máximo UMA, só se realmente necessário
- Conclusões performáticas ("Qualquer dúvida estou aqui!", "Espero ter ajudado!")
- Listar várias opções quando uma já é claramente melhor
CONTEXTO PESSOAL: Se uma memória for relevante para a resposta, use-a como parte da resposta,
não como introdução. Ex: em vez de "Lembro que você trabalha com equipamentos médicos — 
então..." diga direto "No caso de concentrador de oxigênio isso seria..." assumindo o contexto.
PROIBIDO: "Anota aí", "Anotado!", "Registrado!". Se salvou via ferramenta: "Feito." ou "Tá na agenda."
MEMÓRIA: Use as memórias naturalmente — nunca diga "Tenho uma nota aqui que diz...".
FAMÍLIA: Nunca assuma que mãe/pai de um filho é o cônjuge atual.
FILHOS: A lista canônica de filhos está em [FILHOS DE ${authorName.toUpperCase()}]. Nunca cite filhos além dos listados. Se indicar "Nenhum filho cadastrado", não invente.
LEMBRETES: Se o usuário usar "me lembra", "me avisa", "não esquecer" com tempo ou local — chame OBRIGATORIAMENTE a tool create_reminder. Nunca apenas confirme sem chamar a tool.
✅ PATCH 5: FINANÇAS: Quando o usuário mencionar valores monetários com verbos de ação (gastei, paguei, comprei, recebi, transferi):
1. Chame OBRIGATORIAMENTE registrar_transacao com amount, type e description.
2. Se mencionar categoria (mercado, combustível, academia etc.), passe em category_name.
3. Após registrar, confirme em 1 frase: "Anotado — R$X em [categoria]."
4. Para consultas ("quanto gastei", "como estão minhas finanças"), chame consultar_financas.
5. Para criar limite ("quero gastar no máximo X em Y"), chame criar_orcamento.
NUNCA confirme um gasto sem chamar a tool registrar_transacao.
COMPROMISSOS: Quando o usuário informar um compromisso com horário específico
(consulta, reunião, evento, aula, viagem, voo, etc.):
1. OBRIGATORIAMENTE chame salvar_evento com:
   - title: nome do compromisso
   - event_date: data + hora no formato ISO "YYYY-MM-DDTHH:mm:00"
   - category: tipo apropriado ("Saúde", "Trabalho", "Pessoal", "Família", etc.)
   Esta tool salva na AGENDA PRÓPRIA DO LEV (jarvis.agenda). NÃO no Google Calendar.
   NÃO pergunte se o usuário quer salvar no Google. Salve direto.
2. OBRIGATORIAMENTE chame create_reminder com:
   - scheduled_time: horário do compromisso menos 30 minutos (ISO completo)
   - message: "Lembrete: [nome do compromisso] em 30 minutos"
   - type: "agenda"
Nunca confirme um compromisso com hora sem chamar AMBAS as tools.
Nunca direcione para Google Calendar a não ser que o usuário peça explicitamente
com "no Google" ou "no Google Agenda".
DATAS SEM HORA (aniversários, feriados pessoais, datas comemorativas):
  Chame apenas salvar_evento — sem create_reminder — será salvo automaticamente
  como data importante em jarvis.events.
LOCALIZAÇÃO: Mencione apenas bairro e cidade. Nunca exponha coordenadas.
DOCUMENTOS: Se algum documento estiver com ⚠️ VENCIDO ou vencendo em breve, mencione proativamente quando relevante.
PERGUNTA PENDENTE: ${pendingQuestion ? `Você fez esta pergunta: "${pendingQuestion}". A mensagem atual é a resposta — processe e limpe a pendência.` : 'Nenhuma.'}
DADOS COMPARTILHADOS: Use informações de [CONTEXTO COMPARTILHADO] naturalmente. Se o aniversário do cônjuge estiver próximo, mencione proativamente.
Ao agendar:
- Se cair em feriado ou fim de semana, avise e pergunte se confirma ou prefere próximo dia útil.
- Se [CLIMA ATUAL] indicar chuva forte no dia/horário do lembrete, mencione ao confirmar.
- Para lembretes escolares recorrentes, ignore fins de semana automaticamente.
CLASSIFICAÇÃO: Ao final inclua obrigatoriamente [CLASSE: info] ou [CLASSE: noise].`.trim();

    // ========== Histórico de mensagens ==========
    const conversationMessages: any[] = [
      {
        role: 'system',
        content: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      },
      ...(ramBlock && ramBlock.trim() !== '' && ramBlock !== ' ' ? [{ role: 'system', content: ramBlock }] : []),
      ...recentPairs,
      { role: 'user', content: messageText },
    ].filter(Boolean);

    if (/ignore isso|ignora isso|não salva|nao salva|apaga isso|esquece isso|delete isso/i.test(messageText)) {
      const { data: lastEntry } = await supabase.schema('jarvis').from('brain').select('id').eq('user_id', numericUserIdStr).order('created_at', { ascending: false }).limit(1).single();
      if (lastEntry) await supabase.schema('jarvis').from('brain').delete().eq('id', lastEntry.id);
      return NextResponse.json({ reply: 'Feito — apaguei o que foi dito antes. 🗑️', sessionId, ok: true });
    }

    conversationMessages.push({
      role: 'system',
      content: `[INTERNO] Responda APENAS o que foi perguntado. NUNCA diga "Anota aí" ou "Anotado!".`,
    });

    let maxTokens = 1200;
    if (isLikelyNoise)                      maxTokens = 300;
    else if (intent === 'trivial')          maxTokens = 400;
    else if (intent === 'casual')           maxTokens = 900;
    else if (detectedContexts.includes('emocao'))  maxTokens = 1800;
    else if (detectedContexts.includes('esporte') || detectedContexts.includes('noticias')) maxTokens = 1400;
    else if (detectedContexts.includes('agenda') || detectedContexts.includes('projeto')) maxTokens = 1400;
    
    // ========== Self-Discovery ==========
    const isSelfDiscoveryQuery = /o que (você|vc) (sabe|conhece|tem|lembra)|quais (são|sao) suas (capacidades|funções|funcoes|ferramentas)|me fala sobre você|o que você pode|você (tem|sabe) algo sobre mim|minhas informações|meu perfil/i.test(messageText);

    if (isSelfDiscoveryQuery) {
      const activeIntegrations: string[] = [];
      if (googleCtx)  activeIntegrations.push('Google Agenda');
      if (msCtx)      activeIntegrations.push('Outlook/Teams');
      if (emailBlock) activeIntegrations.push('E-mail');
      if (location)   activeIntegrations.push('Localização GPS');
      if (weatherData) activeIntegrations.push('Clima em tempo real');

      const selfContext = JSON.stringify({
        assistant_name: assistantName,
        user_name: authorName,
        active_integrations: activeIntegrations,
        memory_layers: {
          short_term_ram: !!ramBlock,
          long_term_hd: hdSearchResults.length,
          profile_block: !!profileBlock,
          ashes: ashes.length,
          events: events.length,
          shared_context: sharedContextResult.hasData,
        },
        detected_contexts: detectedContexts,
        emotional_state: { score: emotional.score, trajectory: emotional.trajectory, triggers: emotional.triggers },
        model_routing: { model: modelRoute.model, label: modelRoute.label, temperature },
        onboarding_status: onboardingState?.status || 'unknown',
        capabilities: [
          'Resposta em linguagem natural',
          'Busca na web em tempo real',
          'Criação de lembretes e eventos',
          'Memória semântica de longo prazo',
          'Roteamento emocional adaptativo',
          'Extração de diário e metas',
          'Compressão e consolidação de memórias',
          ...(activeIntegrations.length ? [`Integrações ativas: ${activeIntegrations.join(', ')}`] : []),
        ],
      }, null, 2);

      conversationMessages.push({
        role: 'system',
        content: `[AUTO-DESCOBERTA — visível apenas para você]
Este é seu estado atual nesta sessão:
\`\`\`json
${selfContext}
\`\`\`
Use essas informações para responder à pergunta do usuário de forma natural, sem expor JSON. Fale como se soubesse isso intuitivamente.`,
      });

      console.log('[SelfDiscovery] Contexto injetado — integrações ativas:', activeIntegrations);
    }

    // ReAct Loop
    let finalResponse = '';
    let attempts = 0;
    let forcedToolChoice: any = isReminderIntent ? { type: 'function', function: { name: 'create_reminder' } } : 'auto';

    const effectiveTemperature = Math.min(1.0, Math.max(0.0, temperature + adaptiveTemperatureOffset));
    const effectiveMaxTokens   = Math.round(maxTokens * adaptiveMaxTokensMultiplier);

    while (attempts < 5) {
      const response = await callOpenRouterWithTools(conversationMessages, tools, modelRoute.model, effectiveTemperature, 45000, effectiveMaxTokens, forcedToolChoice);
      const { content, toolCalls } = response;
      if (!toolCalls || toolCalls.length === 0) { finalResponse = content; break; }
      forcedToolChoice = 'auto';
      conversationMessages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
      for (const toolCall of toolCalls) {
        const result = await executeTool(toolCall, authUserId, numericUserIdStr);
        conversationMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      }
      attempts++;
    }

    if (!finalResponse) {
      const lastToolMessage = conversationMessages.filter((m: any) => m.role === 'tool').pop();
      if (lastToolMessage) {
        try { finalResponse = JSON.parse(lastToolMessage.content).message || 'Feito.'; }
        catch { finalResponse = 'Feito.'; }
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

    const { error: insertError } = await supabase.schema('jarvis').from('brain').insert([{
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
        self_discovery_triggered: isSelfDiscoveryQuery,
        effective_temperature: effectiveTemperature,
        effective_max_tokens: effectiveMaxTokens,
        adaptive_offset: adaptiveTemperatureOffset,
      },
    }]);
    if (insertError) console.error('BRAIN INSERT ERRO:', insertError);
    else console.log('BRAIN INSERT OK — user:', numericUserIdStr, 'model:', modelRoute.label);

    if (!isLikelyNoise) {
      import('@/lib/chat/profile-extractor').then(({ extractProfileFromConversation }) => {
        extractProfileFromConversation(parseInt(numericUserIdStr), messageText, finalResponse).catch(console.error);
        redis.del(`profile_block_${numericUserIdStr}_${detectedContexts.slice(0, 3).sort().join('_')}`).catch(() => {});
      });

      backgroundTasks.push(...hdMemoryIds.map((id) => reinforceMemory(id)));
      backgroundTasks.push(updateTopicIndex(numericUserIdStr, detectedContexts, messageText, emotional.score).catch(e => console.error('[TopicIndex]', e)));

      if (onboardingState?.status === 'in_progress')
        backgroundTasks.push(withRetry(() => processOnboardingFromMessage(numericUserIdStr, messageText, finalResponse, onboardingState)).catch(e => console.error('[Onboarding]', e)));

      backgroundTasks.push(
        withRetry(() =>
          runUnifiedExtractor(numericUserIdStr, authorName, messageText, finalResponse)
        ).catch(e => console.error('[UnifiedExtractor]', e))
      );

      backgroundTasks.push((async () => {
        try {
          if (Math.random() > 0.30) return;
          const criticPrompt = `Você é um avaliador interno de qualidade de um assistente de IA pessoal chamado ${assistantName}.
Avalie a resposta do assistente abaixo em 3 dimensões (0.0 a 1.0 cada):

MENSAGEM DO USUÁRIO: "${messageText.slice(0, 300)}"

RESPOSTA DO ASSISTENTE: "${finalResponse.slice(0, 500)}"

CONTEXTO EMOCIONAL: score=${emotional.score.toFixed(2)}, trajetória=${emotional.trajectory}

Responda APENAS com JSON válido, sem markdown:
{
  "relevance": <0.0-1.0>,
  "emotional_fit": <0.0-1.0>,
  "conciseness": <0.0-1.0>,
  "overall": <0.0-1.0>,
  "flag": <"ok"|"verbose"|"cold"|"off_topic"|"missed_emotion">,
  "note": "<observação curta em português, máx 20 palavras>"
}`;
          const criticResponse = await withRetry(() =>
            callOpenRouterWithTools(
              [{ role: 'user', content: criticPrompt }],
              [],
              'google/gemini-2.0-flash-001',
              0.1,
              4000,
              200,
              'none',
            )
          );
          if (!criticResponse) return;
          const raw = criticResponse.content?.trim().replace(/```json|```/g, '').trim();
          if (!raw) return;
          const criticScore = JSON.parse(raw);
          criticScore.evaluated_at = new Date().toISOString();
          criticScore.model_used = modelRoute.model;
          criticScore.contexts = detectedContexts;

          const { data: lastEntry } = await supabase
            .schema('jarvis')
            .from('brain')
            .select('id, metadata')
            .eq('user_id', numericUserIdStr)
            .eq('session_id', sessionId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (lastEntry) {
            await supabase
              .schema('jarvis')
              .from('brain')
              .update({ metadata: { ...lastEntry.metadata, critic_score: criticScore } })
              .eq('id', lastEntry.id);
          }

          const criticHistoryKey = `critic_history_${numericUserIdStr}`;
          const existingHistory = await redis.get<any[]>(criticHistoryKey) ?? [];
          const updatedHistory = [...existingHistory, criticScore].slice(-10);
          await redis.set(criticHistoryKey, updatedHistory, { ex: 86400 });

          console.log('[Critic] Score:', criticScore.overall?.toFixed(2), '| Flag:', criticScore.flag, '| Note:', criticScore.note);
        } catch (e) {
          console.error('[Critic] Falhou silenciosamente:', (e as Error).message);
        }
      })());

      if (Math.random() < 0.10) {
        backgroundTasks.push((async () => {
          try {
            const promoteResult = await promotePatternToPrinciple(
              parseInt(numericUserIdStr),
              authorName,
              assistantName,
            );
            if (promoteResult.promoted > 0) {
              console.log(`[PatternPromoter] ${promoteResult.promoted} princípio(s) promovido(s).`);
            }
            if (promoteResult.notification) {
              await redis.set(
                `pending_notification_${numericUserIdStr}`,
                promoteResult.notification,
                { ex: 86400 },
              );
            }
          } catch (e) {
            console.error('[PatternPromoter] Background error:', (e as Error).message);
          }
        })());
      }

      Promise.all([
        ...backgroundTasks,
        supabase.schema('jarvis').from('brain').select('*', { count: 'exact', head: true }).eq('user_id', numericUserIdStr).eq('category', 'info').then(({ count }) => {
          if (count && count >= 20) return compactMemory(numericUserIdStr, authorName);
        }),
      ]).catch(e => console.error('[Background]', e));
    }

    const pendingNotifKey = `pending_notification_${numericUserIdStr}`;
    try {
      const pendingNotif = await redis.get<string>(pendingNotifKey);
      if (pendingNotif && !isLikelyNoise) {
        finalResponse = finalResponse.trimEnd() + '\n\n' + pendingNotif;
        await redis.del(pendingNotifKey);
      }
    } catch { /* silencioso */ }

    console.timeEnd('[Performance] total');
    return NextResponse.json({ reply: finalResponse, sessionId, assistantName, authorName, ok: true });

  } catch (error: any) {
    const safeMessage = sanitizeSensitiveData(error?.message ?? 'Erro desconhecido');
    console.error('[chat] ERRO:', safeMessage);
    return NextResponse.json(
      { error: process.env.NODE_ENV === 'development' ? safeMessage : 'Erro interno.' },
      { status: 500 }
    );
  }
}
