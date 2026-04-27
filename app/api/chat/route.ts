// app/api/chat/route.ts
// Motor V8.13.2 — Self-discovery + Meta-cognição + Promoção automática de padrões + Finanças
// ✅ Ajustado: MemoryManager integrado, Gatekeeper (llmGateway) e QStash Offloading.

import { NextRequest, NextResponse } from 'next/server';
import {
  supabase,
  getOrCreateSession,
  clearPendingQuestion,
} from '@/lib/jarvis';
import { getRecentEmails } from '@/lib/microsoft';
import { getGoogleContext, searchWeb } from '@/lib/google';
import { checkProximidade } from '@/lib/geo';
import { verificarAlertasDeProximidade } from '@/lib/geo-alerts';
import { classifyTemporalHorizon, truncateByWeight } from '@/lib/context-router';
import {
  processOnboardingFromMessage,
} from '@/lib/onboarding';
import { buildGapsBlock } from '@/lib/extractor';
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
import { tools } from '@/lib/chat/tools-def';
import { executeTool } from '@/lib/chat/tools-executor';
import { transcribeAudio, extractAudioBuffer } from '@/lib/services/transcription';
import { computeEmotionalScore } from '@/lib/chat/emotional-router';
import { getUpcomingHolidays } from '@/lib/holidays';
import { Redis } from '@upstash/redis';
import { buildSharedContextBlock } from '@/lib/chat/shared-context';
import { buildPersonalityBlock } from '@/lib/chat/personality';
import { buildProfileBlock } from '@/lib/chat/profile-block';
import { buildFinanceBlock } from '@/lib/finances/db';
import { hasL3Chunks, indexL3Chunks } from '@/lib/chat/l3-chunks';

// NOVOS IMPORTS DE ARQUITETURA
import { MemoryManager } from '@/lib/memory';
import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway';

export const maxDuration = 60;

// CONFIGURAÇÕES DE POLÍTICA
const IDENTITY_COMMAND_CONFIDENCE_THRESHOLD = 0.9;
const BRAIN_SYNC_TIMEOUT_MS = 3000;

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

function buildWeatherBlock(weather: Record<string, any> | null | undefined): string {
  if (!weather) return '';
  const parts: string[] = [];
  if (weather.city) parts.push(weather.city);
  if (weather.temp != null) parts.push(`${Math.round(weather.temp)}°C`);
  if (weather.condition) parts.push(weather.condition);
  if (weather.humidity != null) parts.push(`Umidade ${weather.humidity}%`);
  if (weather.wind != null) parts.push(`Vento ${weather.wind} km/h`);
  if (weather.feelsLike != null) parts.push(`Sensação ${Math.round(weather.feelsLike)}°C`);
  if (weather.forecast) {
    const forecastStr = Array.isArray(weather.forecast)
      ? weather.forecast
        .map((d: any) => `${d.date ?? d.day ?? ''}: ${d.condition ?? d.description ?? ''}`.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(', ')
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
  if (loadCalendar && googleCtx) parts.push(`[AGENDA GOOGLE — somente leitura]\n${googleCtx}`);
  if (loadCalendar && msCtx) parts.push(`[AGENDA OUTLOOK — somente leitura]\n${msCtx}`);
  if (loadCalendar) {
    parts.push(`[INSTRUÇÃO DE AGENDA]\nA agenda PRÓPRIA do Lev é a jarvis.agenda. Use salvar_evento para compromissos.`);
  }
  return parts.join('\n\n');
}

export async function POST(req: NextRequest) {
  const totalStartTime = Date.now();
  console.log('[chat] Iniciando — V8.13.2 (Arquitetura Otimizada)');
  try {
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
      userEmail = (formData.get('userEmail') as string) || (formData.get('email') as string) || '';
      tempUserId = (formData.get('userId') as string) || (formData.get('user_id') as string) || '';
      clientSessionId = formData.get('sessionId') as string | null;
      userFirstName = (formData.get('userFirstName') as string) || 'Usuário';
      const latField = formData.get('latitude') as string | null;
      const lngField = formData.get('longitude') as string | null;
      if (latField && lngField) location = { latitude: parseFloat(latField), longitude: parseFloat(lngField) };
      if (formData.get('weather')) { try { weatherData = JSON.parse(formData.get('weather') as string); } catch { } }

      if (audioFile) {
        const buffer = await extractAudioBuffer(audioFile);
        const result = await transcribeAudio(buffer, { language: 'pt' });
        if (!result.success) return NextResponse.json({ error: result.error || 'Falha na transcrição' }, { status: 401 });
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
      userFirstName = body.userFirstName || 'Usuário';
      if (body.location) location = body.location;
      if (body.weather) weatherData = body.weather;
    }

    messageText = sanitizeSensitiveData(messageText);
    if (!messageText && !location) return NextResponse.json({ error: 'message obrigatório' }, { status: 400 });

    // --- Lookup do usuário (CORRIGIDO) ---
    let userRecord: any = null;
    if (userEmail) userRecord = (await supabase.from('users').select('*').eq('email', userEmail).maybeSingle()).data;
    if (!userRecord && tempUserId) userRecord = (await supabase.from('users').select('*').eq('auth_user_id', tempUserId).maybeSingle()).data;
    if (!userRecord) return NextResponse.json({ error: 'Usuário não encontrado.' }, { status: 404 });

    const numericUserIdStr = String(userRecord.id);
    const authUserId = userRecord.auth_user_id || numericUserIdStr;
    const authorName = userRecord.nickname || userFirstName;
    const assistantName = userRecord.assistant_name || 'Lev';
    const userTimezone = userRecord.timezone || 'America/Sao_Paulo';
    const sessionId = clientSessionId || (await getOrCreateSession(numericUserIdStr));
    const msg_id = crypto.randomUUID(); // Idempotência

    const canonicalDateTimeBlock = buildDateTimeBlock(userTimezone);
    const canonicalDateISO = new Date().toISOString().split('T')[0];

    // Localização
    let locationContext = '';
    if (location) {
      locationContext = await checkProximidade(location.latitude, location.longitude, numericUserIdStr);
      const alertaGeo = await verificarAlertasDeProximidade(authUserId, location.latitude, location.longitude);
      if (alertaGeo.temAlerta) return NextResponse.json({ reply: alertaGeo.mensagem, sessionId, ok: true });
      if (!messageText) messageText = '[Enviou Localização]';
    }

    // ========== 1. Classificação e Embedding ==========
    const queryEmbedding = await getCachedEmbedding(messageText).catch(() => null);
    
    console.time('[Performance] context_classification');
    const contextCacheKey = `ctx_${numericUserIdStr}_${Buffer.from(messageText.slice(0, 30)).toString('base64')}`;
    let detectedContexts = await cache.get<ContextType[]>(contextCacheKey);
    if (!detectedContexts) {
      detectedContexts = await classifyContextWithL4(messageText, numericUserIdStr);
      await cache.set(contextCacheKey, detectedContexts, 20000);
    }
    console.timeEnd('[Performance] context_classification');

    // ========== 2. Emotional Score e MemoryManager ==========
    const emotional = await computeEmotionalScore(messageText, numericUserIdStr, [], '');
    
    // O coração da recuperação: lê todas as camadas via MemoryManager
    const memory = await MemoryManager.read({
      userId: numericUserIdStr,
      authUserId,
      sessionId,
      queryEmbedding,
      contexts: detectedContexts,
      message: messageText,
      emotionalScore: emotional.score,
      authorName
    });

    // Injeção do Alerta de Estabilidade (Circuit Breaker)
    const failCount = await redis.get<number>(`failure_counter:${numericUserIdStr}:background`) || 0;
    const systemWarning = failCount >= 3 ? `\n[ALERTA SISTEMA]: Motor assíncrono instável. Confirme dados críticos.` : '';

    // ========== 3. Roteamento e Planejamento ==========
    const blockPlan = planContextualBlocks(detectedContexts, messageText, emotional.score);
    const modelRoute = routeModel(detectedContexts, emotional.score, undefined);
    const temperature = getTemperature(detectedContexts);

    // Blocos Condicionais (Finanças, Email, etc)
    let financeBlock = '';
    if (blockPlan.loadFinances) financeBlock = await buildFinanceBlock(Number(numericUserIdStr), authUserId).catch(() => '');

    let emailBlock = '';
    if (blockPlan.loadEmail) emailBlock = await getRecentEmails(authUserId, 5).catch(() => '');

    let googleCtx = null;
    if (blockPlan.loadCalendar) googleCtx = (await supabase.rpc('get_calendar_context_for_jarvis', { p_user_id: Number(numericUserIdStr), p_days: 7 })).data;

    // Ajuste Adaptativo
    let adaptiveTempOffset = 0;
    let adaptiveMaxTokensMultiplier = 1.0;
    try {
      const criticHistory = await redis.get<any[]>(`critic_history_${numericUserIdStr}`) ?? [];
      if (criticHistory.length >= 3) {
        const recent = criticHistory.slice(-5);
        const avg = recent.reduce((s, c) => s + (c.overall ?? 0.7), 0) / recent.length;
        if (avg < 0.5) adaptiveTempOffset = 0.1;
      }
    } catch { }

    // Pesquisa Web
    let forcedSearchResult = '';
    if (shouldForceSearch(messageText, detectedContexts) && !weatherData) {
      try { forcedSearchResult = `\n[PESQUISA WEB]\n${await searchWeb(refineSearchQuery(messageText, detectedContexts))}`; } catch {}
    }

    // Ponderação de Tamanho
    const cleanRam = memory.ram.ramBlock.replace(/\[.*?\]\n?/g, '').trim() || ' ';
    const weights = classifyTemporalHorizon(messageText, cleanRam, userRecord.pending_question);
    const truncatedL3 = truncateByWeight(memory.l3.content, weights.l3, 6000);
    const truncatedHd = truncateByWeight(memory.hd.block, weights.hd, 6000);
    const truncatedEvents = truncateByWeight(memory.events.block, weights.events, 6000);

    const isFemale = truncatedL3.toLowerCase().includes('feminino');
    const informalAddress = isFemale ? 'miga' : 'cara';
    const isLikelyNoise = /^(ok|oi|olá|vlw|valeu|👍)[\s!?.]*$/i.test(messageText.trim()) && messageText.length < 15;

    // ========== 4. System Prompt Assembly ==========
    const personalityBlock = buildPersonalityBlock({
      assistantName, authorName, informalAddress, 
      brevityInstruction: isLikelyNoise ? 'Curto e humano.' : (detectedContexts.includes('casual') ? 'Máximo 3 frases.' : 'Direto.'),
      emotionalAttentionNote: emotional.score > 0.5 ? 'Acolha antes de resolver.' : '',
      canonicalDateTimeBlock, canonicalDateISO,
      weatherBlock: (blockPlan.loadWeather && weatherData) ? buildWeatherBlock(weatherData) : undefined,
    });

    const systemPrompt = `${personalityBlock}${systemWarning}
${forcedSearchResult}
${buildAgendaBlock(blockPlan.loadCalendar, googleCtx, null, numericUserIdStr)}
${financeBlock ? `[FINANÇAS]\n${financeBlock}` : ''}
${emailBlock ? `[EMAILS]\n${emailBlock}` : ''}
${locationContext ? `\n[LOCALIZAÇÃO]\n${locationContext}` : ''}
${memory.relationship.hasData ? `\n${memory.relationship.block}` : ''}
${memory.topics.relatedTopicsBlock}
${truncatedL3 ? `[PERFIL]\n${truncatedL3}` : ''}
${memory.topics.recommendationsBlock ? `\n${memory.topics.recommendationsBlock}` : ''}
${truncatedHd ? `[MEMÓRIAS]\n${truncatedHd}` : ''}
${memory.ashes.block ? `[PASSADO DISTANTE]\n${memory.ashes.block}` : ''}
[EVENTOS]\n${truncatedEvents}
${userRecord.pending_question ? `PERGUNTA PENDENTE: ${userRecord.pending_question}` : ''}

REGRAS: Responda o que foi perguntado. NUNCA diga "Anotado".
Para compromissos: chame salvar_evento E create_reminder.
Para finanças: chame registrar_transacao.
[CLASSE: info] ou [CLASSE: noise] ao final.`.trim();

    const conversationMessages = [
      { role: 'system', content: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] },
      ...(memory.ram.ramBlock ? [{ role: 'system', content: memory.ram.ramBlock }] : []),
      ...memory.ram.recentPairs,
      { role: 'user', content: messageText },
    ];

    // Self-Discovery
    if (/o que (você|vc) (sabe|conhece|tem|lembra)/i.test(messageText)) {
      conversationMessages.push({ role: 'system', content: `[AUTO-DESCOBERTA] V8.13.2 Ativo. Cache de Identidade L0 e Memória Semântica L3/HD operantes.` });
    }

    // ========== 5. ReAct Loop (Via llmGateway) ==========
    let finalResponse = '';
    let attempts = 0;
    let forcedToolChoice: any = /me lembra|avisa/i.test(messageText) ? { type: 'function', function: { name: 'create_reminder' } } : 'auto';
    
    // Lógica de Tokens Dinâmica
    let maxTokens = isLikelyNoise ? 150 : detectedContexts.includes('emocao') ? 800 : 500;

    while (attempts < 5) {
      const response = await callOpenRouterWithPriority(
        1, 'never', `chat_${msg_id}`,
        conversationMessages, tools, modelRoute.model,
        Math.min(1.0, temperature + adaptiveTempOffset), 35000, 
        Math.round(maxTokens * adaptiveMaxTokensMultiplier), forcedToolChoice
      );
      
      const { content, toolCalls } = response as any;
      if (!toolCalls?.length) { finalResponse = content; break; }
      forcedToolChoice = 'auto';
      conversationMessages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
      for (const toolCall of toolCalls) {
        const result = await executeTool(toolCall, authUserId, numericUserIdStr);
        conversationMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      }
      attempts++;
    }

    if (!finalResponse) finalResponse = 'Feito.';
    
    let category = 'info';
    const categoryMatch = finalResponse.match(/\[CLASSE:\s*(\w+)\]/i);
    if (categoryMatch) category = categoryMatch[1].toLowerCase();
    finalResponse = finalResponse.replace(/\[CLASSE:.*?\]/gi, '').trim();

    if (userRecord.pending_question) await clearPendingQuestion(numericUserIdStr);

    // ========== 6. Escrita Síncrona na RAM (Timeout 3s) ==========
    try {
      const brainWrite = MemoryManager.write({
        type: 'conversation', userId: numericUserIdStr, sessionId, messageText, aiReply: finalResponse,
        category, embedding: queryEmbedding || undefined, metadata: { msg_id, model: modelRoute.label }
      });
      await Promise.race([brainWrite, new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), BRAIN_SYNC_TIMEOUT_MS))]);
    } catch { console.warn(`[Sync] Falhou para ${msg_id}. Recovery via QStash.`); }

    // ========== 7. Despacho Assíncrono (QStash) ==========
    if (!isLikelyNoise) {
      const qstashPayload = {
        msg_id, userId: numericUserIdStr, authorName, assistantName, sessionId,
        message: messageText, reply: finalResponse, contexts: detectedContexts,
        emotional, modelRoute: modelRoute.model
      };

      fetch(`${process.env.QSTASH_URL}/v2/publish/${process.env.NEXT_PUBLIC_APP_URL}/api/jobs-processor`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.QSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(qstashPayload)
      }).catch(e => console.error('[QStash] Erro:', e));
    }

    console.log(`[Performance] Total Rota: ${Date.now() - totalStartTime}ms`);
    return NextResponse.json({ reply: finalResponse, sessionId, assistantName, authorName, ok: true });

  } catch (error: any) {
    console.error('[chat] ERRO FATAL:', error);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}
