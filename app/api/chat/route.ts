// app/api/chat/route.ts
// Motor V8.13.2 — Memória Centralizada + QStash Asynchronous Processing + Lógica Completa

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { MemoryManager } from '@/lib/memory';
import { getRecentEmails } from '@/lib/microsoft';
import { searchWeb } from '@/lib/google';
import { checkProximidade } from '@/lib/geo';
import { verificarAlertasDeProximidade } from '@/lib/geo-alerts';
import { classifyTemporalHorizon, truncateByWeight } from '@/lib/context-router';
import { buildOnboardingBlock } from '@/lib/onboarding';
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
import { callOpenRouterWithTools } from '@/lib/chat/openrouter';
import { transcribeAudio, extractAudioBuffer } from '@/lib/services/transcription';
import { computeEmotionalScore } from '@/lib/chat/emotional-router';
import { getUpcomingHolidays } from '@/lib/holidays';
import { Redis } from '@upstash/redis';
import { buildPersonalityBlock } from '@/lib/chat/personality';
import { buildFinanceBlock } from '@/lib/finances/db';
import { getOrCreateSession, clearPendingQuestion } from '@/lib/jarvis';

export const maxDuration = 60;

// CONFIGURAÇÕES DE POLÍTICA
const IDENTITY_COMMAND_CONFIDENCE_THRESHOLD = 0.9;
const BRAIN_SYNC_TIMEOUT_MS = 3000;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const cache = {
  async get<T>(key: string): Promise<T | null> {
    try { const val = await redis.get<T>(key); return val ?? null; } 
    catch { return null; }
  },
  async set<T>(key: string, value: T, ttlMs = 30000): Promise<void> {
    try { await redis.set(key, value, { ex: Math.max(1, Math.floor(ttlMs / 1000)) }); } 
    catch { }
  },
};

// --- Utilitários de Formatação e Segurança ---

function sanitizeSensitiveData(text: string): string {
  if (!text) return text;
  const patterns = [ /(sk-[A-Za-z0-9_\-]{20,})/gi, /(Bearer\s+[A-Za-z0-9_\-\.]{20,})/gi, /(Authorization:\s*['"]?[A-Za-z0-9_\-]+)/gi, /(api[_-]?key['"]?\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,})/gi, /(password['"]?\s*[:=]\s*['"]?[^'"\s]{4,})/gi, /(secret['"]?\s*[:=]\s*['"]?[^'"\s]{4,})/gi, /(token['"]?\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,})/gi, /(x-api-key['"]?\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,})/gi ];
  let sanitized = text;
  for (const p of patterns) sanitized = sanitized.replace(p, match => match.includes('=') ? match.replace(/=.*/, '= [REDACTED]') : match.includes(':') ? match.replace(/:.*/, ': [REDACTED]') : '[REDACTED]');
  return sanitized;
}

function buildDateTimeBlock(timezone: string): string {
  const now = new Date();
  const locale = 'pt-BR';
  const dateStr = now.toLocaleDateString(locale, { timeZone: timezone, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = now.toLocaleTimeString(locale, { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
  return `${dateStr} às ${timeStr} (${timezone})`;
}

function buildAgendaBlock(loadCalendar: boolean, googleCtx: string | null, msCtx: any): string {
  const parts: string[] = [];
  if (loadCalendar && googleCtx) parts.push(`[AGENDA GOOGLE — leitura]\n${googleCtx}`);
  if (loadCalendar && msCtx) parts.push(`[AGENDA OUTLOOK — leitura]\n${msCtx}`);
  if (loadCalendar) parts.push(`[INSTRUÇÃO DE AGENDA]\nA agenda PRÓPRIA do Lev é a jarvis.agenda. Use salvar_evento para compromissos.`);
  return parts.join('\n\n');
}

// --- Rota Principal ---

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  console.log('[chat] Iniciando — V8.13.2 (Arquitetura QStash + MemoryManager)');
  
  try {
    let messageText = '';
    let userEmail = '';
    let tempUserId = '';
    let clientSessionId: string | null = null;
    let userFirstName = 'Usuário';
    let location: { latitude: number; longitude: number } | null = null;
    let weatherData: Record<string, any> | null = null;

    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const audioFile = formData.get('audio') as File | null;
      userEmail = (formData.get('userEmail') as string) || (formData.get('email') as string) || '';
      tempUserId = (formData.get('userId') as string) || (formData.get('user_id') as string) || '';
      clientSessionId = formData.get('sessionId') as string | null;
      userFirstName = (formData.get('userFirstName') as string) || 'Usuário';
      if (formData.get('latitude')) location = { latitude: parseFloat(formData.get('latitude') as string), longitude: parseFloat(formData.get('longitude') as string) };
      if (formData.get('weather')) { try { weatherData = JSON.parse(formData.get('weather') as string); } catch { } }

      if (audioFile) {
        const buffer = await extractAudioBuffer(audioFile);
        const result = await transcribeAudio(buffer, { language: 'pt' });
        if (!result.success) return NextResponse.json({ error: result.error }, { status: 401 });
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
    if (!messageText && !location) return NextResponse.json({ error: 'Mensagem vazia' }, { status: 400 });

    // Lookup de Usuário Seguro
    let userRecord: any = null;
    if (userEmail) userRecord = (await supabase.from('users').select('*').eq('email', userEmail).maybeSingle()).data;
    if (!userRecord && tempUserId) userRecord = (await supabase.from('users').select('*').eq('auth_user_id', tempUserId).maybeSingle()).data;
    if (!userRecord) return NextResponse.json({ error: 'Usuário não encontrado.' }, { status: 404 });

    const numericUserIdStr = String(userRecord.id);
    const authUserId = userRecord.auth_user_id || numericUserIdStr;
    const authorName = userRecord.nickname || userFirstName;
    const assistantName = userRecord.assistant_name || 'Lev';
    const sessionId = clientSessionId || (await getOrCreateSession(numericUserIdStr));
    const msg_id = crypto.randomUUID();

    // Geolocalização e Alertas
    let locationContext = '';
    if (location) {
      locationContext = await checkProximidade(location.latitude, location.longitude, numericUserIdStr);
      const alertaGeo = await verificarAlertasDeProximidade(authUserId, location.latitude, location.longitude);
      if (alertaGeo.temAlerta) return NextResponse.json({ reply: alertaGeo.mensagem, sessionId, ok: true });
      if (!messageText) messageText = '[Enviou Localização]';
    }

    // Classificações e Memória
    const queryEmbedding = await getCachedEmbedding(messageText).catch(() => null);
    const detectedContexts = await cache.get<ContextType[]>(`ctx_${numericUserIdStr}_${msg_id}`) 
      || await classifyContextWithL4(messageText, numericUserIdStr);
    
    const emotional = await computeEmotionalScore(messageText, numericUserIdStr, [], '');
    const blockPlan = planContextualBlocks(detectedContexts, messageText, emotional.score);
    const modelRoute = routeModel(detectedContexts, emotional.score, undefined);

    // Carregamento da Memória Centralizada
    const memory = await MemoryManager.read({
      userId: numericUserIdStr, authUserId, sessionId, queryEmbedding,
      contexts: detectedContexts, message: messageText, emotionalScore: emotional.score, authorName
    });

    // Injeção de Aviso se o Background estiver instável
    const failCount = await redis.get<number>(`failure_counter:${numericUserIdStr}:background`) || 0;
    const systemWarning = failCount >= 3 ? `\n[ALERTA SISTEMA]: Motor assíncrono instável. Confirme dados críticos.` : '';

    // Blocos Condicionais (Finanças, Email, Agenda)
    let financeBlock = '', emailBlock = '', googleCtx = null;
    if (blockPlan.loadFinances) financeBlock = await buildFinanceBlock(Number(numericUserIdStr), authUserId).catch(() => '');
    if (blockPlan.loadEmail) emailBlock = await getRecentEmails(authUserId, 5).catch(() => '');
    if (blockPlan.loadCalendar) googleCtx = (await supabase.rpc('get_calendar_context_for_jarvis', { p_user_id: Number(numericUserIdStr), p_days: 7 })).data;

    // Ajuste de Tokens e Temperatura Adaptativa
    let adaptiveTempOffset = 0;
    try {
      const criticHist = await redis.get<any[]>(`critic_history_${numericUserIdStr}`) ?? [];
      if (criticHist.length >= 3 && (criticHist.reduce((s, c) => s + (c.overall ?? 0.7), 0) / criticHist.length) < 0.5) adaptiveTempOffset = 0.1;
    } catch { }

    const isLikelyNoise = /^(ok|oi|valeu|obrigado|👍)[\s!?.]*$/i.test(messageText.trim()) && messageText.length < 15;
    let maxTokens = isLikelyNoise ? 150 : detectedContexts.includes('emocao') ? 800 : 500;

    // Prompt e Personalidade
    const personalityBlock = buildPersonalityBlock({
      assistantName, authorName, informalAddress: memory.l3.content.toLowerCase().includes('feminino') ? 'miga' : 'cara',
      brevityInstruction: isLikelyNoise ? 'Curto e humano.' : 'Direto.',
      emotionalAttentionNote: emotional.score > 0.5 ? 'Acolha antes de resolver.' : '',
      canonicalDateTimeBlock: buildDateTimeBlock(userRecord.timezone), canonicalDateISO: new Date().toISOString().split('T')[0],
      weatherBlock: (blockPlan.loadWeather && weatherData) ? `${weatherData.temp}°C em ${weatherData.city}` : undefined,
    });

    const systemPrompt = `${personalityBlock}${systemWarning}
${buildAgendaBlock(blockPlan.loadCalendar, googleCtx, null)}
${financeBlock ? `[FINANÇAS]\n${financeBlock}` : ''}
${emailBlock ? `[EMAILS]\n${emailBlock}` : ''}
${locationContext ? `\n[LOCALIZAÇÃO]\n${locationContext}` : ''}
${memory.l3.content ? `[PERFIL]\n${truncateByWeight(memory.l3.content, 0.8, 4000)}` : ''}
${memory.hd.block ? `[MEMÓRIAS]\n${truncateByWeight(memory.hd.block, 0.5, 4000)}` : ''}
[EVENTOS]\n${truncateByWeight(memory.events.block, 0.7, 4000)}
[CLASSE: info] ou [CLASSE: noise] ao final.`.trim();

    // Chamada à LLM (Gatekeeper)
    const { content: finalResponse } = await callOpenRouterWithTools(
      [{ role: 'system', content: systemPrompt }, ...memory.ram.recentPairs, { role: 'user', content: messageText }],
      tools, modelRoute.model, Math.min(1.0, getTemperature(detectedContexts) + adaptiveTempOffset), 35000, maxTokens
    );

    // Escrita Síncrona na RAM (Ponto de não-retorno com Timeout de 3s)
    try {
      await Promise.race([
        MemoryManager.write({ type: 'conversation', userId: numericUserIdStr, sessionId, messageText, aiReply: finalResponse, embedding: queryEmbedding || undefined, metadata: { msg_id } }),
        new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), BRAIN_SYNC_TIMEOUT_MS))
      ]);
    } catch { console.warn(`[Sync] Falhou para ${msg_id}. Self-healing via QStash.`); }

    // Despacho Assíncrono (QStash)
    if (!isLikelyNoise) {
      fetch(`${process.env.QSTASH_URL}/v2/publish/${process.env.NEXT_PUBLIC_APP_URL}/api/jobs-processor`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.QSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_id, userId: numericUserIdStr, authorName, assistantName, sessionId, message: messageText, reply: finalResponse, contexts: detectedContexts, emotional, modelRoute: modelRoute.model })
      }).catch(() => {});
    }

    if (userRecord.pending_question) await clearPendingQuestion(numericUserIdStr);

    console.log(`[Performance] Total: ${Date.now() - startTime}ms`);
    return NextResponse.json({ reply: finalResponse.replace(/\[CLASSE:.*?\]/gi, '').trim(), sessionId, ok: true });

  } catch (error) {
    console.error('[Fatal]', error);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}
