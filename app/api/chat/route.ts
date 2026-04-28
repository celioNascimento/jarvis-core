// app/api/chat/route.ts
// Motor V8.13.3 — Self-discovery + Graceful Degradation + Modo Sobrevivência (Stress Check)

import { NextRequest, NextResponse } from 'next/server';
import { supabase, getOrCreateSession, clearPendingQuestion } from '@/lib/jarvis';
import { getRecentEmails } from '@/lib/microsoft';
import { getGoogleContext, searchWeb } from '@/lib/google';
import { checkProximidade } from '@/lib/geo';
import { verificarAlertasDeProximidade } from '@/lib/geo-alerts';
import { classifyTemporalHorizon, truncateByWeight } from '@/lib/context-router';
import { initOnboarding, buildOnboardingBlock } from '@/lib/onboarding';
import { buildGapsBlock } from '@/lib/extractor';
import { buildDiaryGoalsBlock } from '@/lib/diary';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import {
  classifyContextWithL4,
  routeModel,
  getTemperature,
  planContextualBlocks,
  type ContextType,
} from '@/lib/chat/context-classifier';
import { shouldForceSearch, refineSearchQuery } from '@/lib/chat/search-router';
import { tools } from '@/lib/chat/tools-def';
import { executeTool } from '@/lib/chat/tools-executor';
import { transcribeAudio, extractAudioBuffer } from '@/lib/services/transcription';
import { computeEmotionalScore } from '@/lib/chat/emotional-router';
import { getUpcomingHolidays } from '@/lib/holidays';
import { Redis } from '@upstash/redis';
import { buildPersonalityBlock } from '@/lib/chat/personality';
import { buildProfileBlock } from '@/lib/chat/profile-block';
import { buildFinanceBlock } from '@/lib/finances/db';
import { isMeaningfulDiaryBlock } from '@/lib/chat/ram';

// IMPORTS DA NOVA ARQUITETURA
import { MemoryManager } from '@/lib/memory';
import { callOpenRouterWithPriority, llmGateway } from '@/lib/chat/llm-gateway'; // <--- IMPORT ATUALIZADO

export const maxDuration = 60;

const BRAIN_SYNC_TIMEOUT_MS = 3000;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const cache = {
  async get<T>(key: string): Promise<T | null> {
    try { const val = await redis.get<T>(key); return val ?? null; } catch { return null; }
  },
  async set<T>(key: string, value: T, ttlMs = 30000): Promise<void> {
    try { await redis.set(key, value, { ex: Math.max(1, Math.floor(ttlMs / 1000)) }); } catch { }
  },
};

function sanitizeSensitiveData(text: string): string {
  if (!text) return text;
  const patterns = [/(sk-[A-Za-z0-9_\-]{20,})/gi, /(Bearer\s+[A-Za-z0-9_\-\.]{20,})/gi, /(Authorization:\s*['"]?[A-Za-z0-9_\-]+)/gi, /(api[_-]?key['"]?\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,})/gi, /(password['"]?\s*[:=]\s*['"]?[^'"\s]{4,})/gi, /(secret['"]?\s*[:=]\s*['"]?[^'"\s]{4,})/gi, /(token['"]?\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,})/gi, /(x-api-key['"]?\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,})/gi];
  let sanitized = text;
  for (const p of patterns) sanitized = sanitized.replace(p, match => match.includes('=') ? match.replace(/=.*/, '= [REDACTED]') : match.includes(':') ? match.replace(/:.*/, ': [REDACTED]') : '[REDACTED]');
  return sanitized;
}

function buildDateTimeBlock(timezone: string): string {
  const now = new Date();
  const locale = 'pt-BR';
  return `${now.toLocaleDateString(locale, { timeZone: timezone, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })} às ${now.toLocaleTimeString(locale, { timeZone: timezone, hour: '2-digit', minute: '2-digit' })} (${timezone})`;
}

async function getOrCreateOnboardingStatePersistent(userId: string) {
  const { data } = await supabase.from('memories').select('metadata').eq('user_id', userId).eq('category', 'onboarding').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (data?.metadata?.state) return data.metadata.state;
  return await initOnboarding(userId);
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
  return parts.join(' · ');
}

export function buildAgendaBlock(loadCalendar: boolean, googleCtx: string | null, msCtx: any): string {
  const parts: string[] = [];
  if (loadCalendar && googleCtx) parts.push(`[AGENDA GOOGLE — somente leitura]\n${googleCtx}`);
  if (loadCalendar && msCtx) parts.push(`[AGENDA OUTLOOK — somente leitura]\n${msCtx}`);
  if (loadCalendar) parts.push(`[INSTRUÇÃO DE AGENDA]\nA agenda PRÓPRIA do Lev é a jarvis.agenda. Ao salvar compromissos, use SEMPRE salvar_evento (jarvis.agenda).`);
  return parts.join('\n\n');
}

export async function POST(req: NextRequest) {
  const totalStartTime = Date.now();
  console.log('[chat] Iniciando — V8.13.3 (Modo de Sobrevivência Ativo)');
  
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
        if (!result.success) return NextResponse.json({ error: result.error || 'Falha' }, { status: 401 });
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
    const msg_id = crypto.randomUUID();

    // =========================================================================
    // 🚨 SENSOR DE STRESS (GRACEFUL DEGRADATION) 🚨
    // =========================================================================
    const isSystemStressed = await llmGateway.isOverloaded();
    if (isSystemStressed) {
      console.warn(`[Graceful Degradation] ⚠️ Sistema sob stress. Entrando em Modo Sobrevivência para msg: ${msg_id}`);
    }

    const canonicalDateTimeBlock = buildDateTimeBlock(userTimezone);
    const canonicalDateISO = new Date().toISOString().split('T')[0];

    let locationContext = '';
    // Só processamos geolocalização se o sistema NÃO estiver estressado
    if (location && !isSystemStressed) {
      locationContext = await checkProximidade(location.latitude, location.longitude, numericUserIdStr);
      const alertaGeo = await verificarAlertasDeProximidade(authUserId, location.latitude, location.longitude);
      if (alertaGeo.temAlerta) return NextResponse.json({ reply: alertaGeo.mensagem, sessionId, ok: true });

      try {
        await supabase.from('config').upsert(
          { key: `last_location_${numericUserIdStr}`, value: JSON.stringify({ lat: location.latitude, lng: location.longitude, ts: Date.now() }) },
          { onConflict: 'key' }
        );
      } catch (err) {
        console.warn('[Config] Erro ignorado ao salvar localizacao');
      }
      if (!messageText) messageText = '[Enviou Localização]';
    } else if (location && isSystemStressed) {
      if (!messageText) messageText = '[Enviou Localização - ignorada por tráfego alto]';
    }

    // ========== 1. Embeddings, L4 e Memória ==========
    const queryEmbedding = await getCachedEmbedding(messageText).catch(() => null);

    const contextCacheKey = `ctx_${numericUserIdStr}_${Buffer.from(messageText.slice(0, 30)).toString('base64')}`;
    let detectedContexts = await cache.get<ContextType[]>(contextCacheKey);
    if (!detectedContexts) {
      detectedContexts = await classifyContextWithL4(messageText, numericUserIdStr);
      await cache.set(contextCacheKey, detectedContexts, 20000);
    }

    const emotional = await computeEmotionalScore(messageText, numericUserIdStr, [], '');
    const blockPlan = planContextualBlocks(detectedContexts, messageText, emotional.score);
    
    // 🚨 CORTES DO MODO SOBREVIVÊNCIA
    if (isSystemStressed) {
      blockPlan.loadWeather = false;
      blockPlan.loadFinances = false;
      blockPlan.loadEmail = false;
    }

    const modelRoute = routeModel(detectedContexts, emotional.score, undefined);
    const temperature = getTemperature(detectedContexts);

    const memory = await MemoryManager.read({
      userId: numericUserIdStr, authUserId, sessionId, queryEmbedding,
      contexts: detectedContexts, message: messageText, emotionalScore: emotional.score, authorName, assistantName
    });

    const failCount = await redis.get<number>(`failure_counter:${numericUserIdStr}:background`) || 0;
    const systemWarning = failCount >= 3 ? `\n[ALERTA SISTEMA]: Motor assíncrono instável. Confirme dados críticos.` : '';

    function classifyIntent(message: string): string {
      const m = message.toLowerCase();
      if (/foco|tdah|sobrecarregado|procrastinando|travado|paralisado|por onde começo|quebrar tarefa/.test(m)) return 'focus';
      if (/agenda|reunião|compromisso|semana|calendário/.test(m)) return 'calendar';
      if (/email|mensagem|caixa|inbox|respondeu/.test(m)) return 'email';
      if (/lembra|me avisa|não esquecer|lembrete|avisa/.test(m)) return 'reminder';
      if (/como fazer|o que é|diferença|explica|qual é|por que|como funciona/.test(m)) return 'factual';
      if (/me sinto|tô |estou |foi difícil|desabafar|cansado|ansioso/.test(m)) return 'personal';
      if (/faz|cria|gera|escreve|monta|lista|resume/.test(m)) return 'task';
      return 'personal';
    }
    const intent = classifyIntent(messageText);

    // ========== 2. Blocos Adicionais Restaurados ==========
    const [
      principles,
      childrenData,
      personNotesData,
      onboardingState,
      dynamicGuidelines,
      profileBlock,
      gapsBlock,
      diaryBlock,
    ] = await Promise.all([
      (async () => {
        const key = `principles_${numericUserIdStr}`;
        const cached = await cache.get<{ global: any[]; individual: any[] }>(key);
        if (cached) return cached;
        const [globalRes, userRes] = await Promise.all([
          supabase.schema('jarvis').from('principles').select('content, category').is('user_id', null).order('created_at', { ascending: true }),
          supabase.schema('jarvis').from('principles').select('content, category').eq('user_id', numericUserIdStr).order('created_at', { ascending: true }),
        ]);
        const val = { global: globalRes.data || [], individual: userRes.data || [] };
        await cache.set(key, val, 60000); return val;
      })(),
      (async () => {
        const { data } = await supabase.from('children').select('name, nickname, lev_notes').eq('parent_id', numericUserIdStr);
        return data || [];
      })(),
      (async () => {
        const { data } = await supabase.from('person_notes').select('person_name, person_type, note, noted_at').eq('user_id', numericUserIdStr).order('noted_at', { ascending: false }).limit(20);
        return data || [];
      })(),
      (async () => {
        const { data } = await supabase.from('onboarding_progress').select('*').eq('user_id', numericUserIdStr).maybeSingle();
        return data || await getOrCreateOnboardingStatePersistent(numericUserIdStr);
      })(),
      (async () => {
        if (!numericUserIdStr || numericUserIdStr === 'undefined') return '';
        try {
          const { data } = await supabase.schema('jarvis').from('dynamic_guidelines')
            .select('content').eq('active', true)
            .or(`user_id.eq.${numericUserIdStr},scope.eq.global`)
            .order('created_at', { ascending: false }).limit(10);
          return data?.length ? data.map((g: any) => `- ${g.content}`).join('\n') : '';
        } catch { return ''; }
      })(),
      blockPlan.loadL3 ? buildProfileBlock({ userId: Number(numericUserIdStr), authUserId, authorName, contexts: detectedContexts }).catch(() => '') : Promise.resolve(''),
      blockPlan.loadGaps ? buildGapsBlock(numericUserIdStr, messageText).catch(() => '') : Promise.resolve(''),
      blockPlan.loadDiary ? buildDiaryGoalsBlock(numericUserIdStr).catch(() => '') : Promise.resolve(''),
    ]);

    let financeBlock = '', emailBlock = '', googleCtx = null;
    if (blockPlan.loadFinances && !isSystemStressed) financeBlock = await buildFinanceBlock(Number(numericUserIdStr), authUserId).catch(() => '');
    if (blockPlan.loadEmail && !isSystemStressed) emailBlock = await getRecentEmails(authUserId, 5).catch(() => '');
    if (blockPlan.loadCalendar) googleCtx = (await supabase.rpc('get_calendar_context_for_jarvis', { p_user_id: Number(numericUserIdStr), p_days: 7 })).data;

    let adaptiveTempOffset = 0, adaptiveMaxTokensMultiplier = 1.0;
    try {
      const criticHist = await redis.get<any[]>(`critic_history_${numericUserIdStr}`) ?? [];
      if (criticHist.length >= 3) {
        const recent = criticHist.slice(-5);
        if ((recent.reduce((s, c) => s + (c.overall ?? 0.7), 0) / recent.length) < 0.5) adaptiveTempOffset = 0.1;
        const dominantFlag = Object.entries(recent.reduce((acc: any, c) => { acc[c.flag] = (acc[c.flag] || 0) + 1; return acc; }, {})).sort((a: any, b: any) => b[1] - a[1])[0]?.[0];
        if (dominantFlag === 'verbose') adaptiveMaxTokensMultiplier = 0.8;
        if (dominantFlag === 'cold') adaptiveTempOffset = 0.15;
      }
    } catch { }

    let forcedSearchResult = '';
    // 🚨 CORTE: Não fazemos busca automática se estiver estressado
    if (shouldForceSearch(messageText, detectedContexts) && !weatherData && !isSystemStressed) {
      try { forcedSearchResult = `\n[PESQUISA AUTOMÁTICA REALIZADA]\n${await searchWeb(refineSearchQuery(messageText, detectedContexts))}`; } catch { }
    }

    let holidaysBlock = '';
    if (detectedContexts.includes('agenda') || detectedContexts.includes('evento') || detectedContexts.includes('familia')) {
      const holidays = await getUpcomingHolidays(10).catch(() => []);
      if (holidays.length) holidaysBlock = `\n[FERIADOS NACIONAIS PRÓXIMOS]\n${holidays.map(h => `- ${h.name}: ${new Date(h.date).toLocaleDateString('pt-BR')}`).join('\n')}`;
    }

    let personNotesBlock = '';
    const msgLower = messageText.toLowerCase();
    const childNotes = childrenData.filter((c: any) => msgLower.includes((c.nickname || '').toLowerCase()) || msgLower.includes((c.name || '').split(' ')[0].toLowerCase()));
    const pNotes = personNotesData.filter((n: any) => n.person_name.toLowerCase().split(' ').some((p: string) => p.length >= 3 && new RegExp(`\\b${p}\\b`).test(msgLower)));
    if (childNotes.length > 0 || pNotes.length > 0) {
      const lines: string[] = [];
      for (const c of childNotes) lines.push(`${c.nickname || c.name.split(' ')[0]}: ${c.lev_notes}`);
      for (const n of pNotes) lines.push(`${n.person_name} [${n.noted_at}]: ${n.note}`);
      personNotesBlock = `[NOTAS SOBRE PESSOAS MENCIONADAS]\n${lines.join('\n')}`;
    }

    const { global: globalPrinciples, individual: individualPrinciples } = principles;
    const principlesText = [
      globalPrinciples.length ? `🔒 PRINCÍPIOS INVIOLÁVEIS:\n${globalPrinciples.map((p: any) => `- [${p.category || 'Geral'}] ${p.content}`).join('\n')}` : '',
      individualPrinciples.length ? `👤 PRINCÍPIOS PESSOAIS de ${authorName}:\n${individualPrinciples.map((p: any) => `- [${p.category || 'Geral'}] ${p.content}`).join('\n')}` : ''
    ].filter(Boolean).join('\n\n');

    const cleanRam = memory.ram.ramBlock.replace(/\[.*?\]\n?/g, '').trim() || ' ';
    const weights = classifyTemporalHorizon(messageText, cleanRam, userRecord.pending_question);
    const truncatedL3 = truncateByWeight(memory.l3.content, weights.l3, 6000);
    const truncatedHd = truncateByWeight(memory.hd.block, weights.hd, 6000);
    const truncatedEvents = truncateByWeight(memory.events.block, weights.events, 6000);

    const isLikelyNoise = /^(ok|oi|olá|vlw|valeu|👍|obrigado)[\s!?.]*$/i.test(messageText.trim()) && messageText.length < 15;

    // ========== 3. MONTAGEM DO PROMPT COMPLETO ORIGINAL ==========
    const personalityBlock = buildPersonalityBlock({
      assistantName, authorName, informalAddress: truncatedL3.toLowerCase().includes('feminino') ? 'miga' : 'cara',
      brevityInstruction: isLikelyNoise ? 'Curto e humano. 1-2 frases.' : (detectedContexts.includes('casual') ? 'Conversa casual, máximo 3 frases.' : 'Seja direto. Sem rodeios.'),
      emotionalAttentionNote: emotional.score > 0.5 ? `⚠️ ATENÇÃO EMOCIONAL: (score ${emotional.score.toFixed(2)}). Acolha antes de resolver.` : '',
      canonicalDateTimeBlock, canonicalDateISO,
      weatherBlock: (blockPlan.loadWeather && weatherData && !isSystemStressed) ? buildWeatherBlock(weatherData) : undefined,
    });

    const systemPrompt = `${personalityBlock}${systemWarning}

🚨 INTEGRIDADE FACTUAL — OBRIGATÓRIA 🚨

1. DATAS: Qualquer informação temporal DEVE ser coerente com a data canônica acima.
   - Nunca confirme uma data informada pelo usuário sem verificar.

2. ANTI-SYCOPHANCY: Se o usuário disser "você errou":
   - NÃO concorde imediatamente.
   - Refaça a busca com a data canônica como âncora.
   - Só corrija se os novos resultados confirmarem o erro.

3. PESQUISA: Para jogos, resultados, datas, notícias, cotações, clima em outras cidades — chame searchWeb ANTES de responder.

${forcedSearchResult}
${holidaysBlock}
${buildAgendaBlock(blockPlan.loadCalendar, googleCtx, null)}
${financeBlock ? `[FINANÇAS]\n${financeBlock}` : ''}
${emailBlock ? `[EMAILS RECENTES]\n${emailBlock}` : ''}
${locationContext ? `\n${locationContext}` : ''}
${memory.relationship.hasData ? `\n${memory.relationship.block}` : ''}
${memory.topics.relatedTopicsBlock}
${truncatedL3 ? `[QUEM É ${authorName.toUpperCase()}]\n${truncatedL3}` : ''}
${profileBlock}
${personNotesBlock}
${memory.topics.recommendationsBlock ? `\n${memory.topics.recommendationsBlock}` : ''}
${memory.topics.topicBlock}
${isMeaningfulDiaryBlock(diaryBlock) ? diaryBlock : ''}
${truncatedHd ? `[MEMÓRIAS DE LONGO PRAZO]\n${truncatedHd}` : ''}
${memory.ashes.block ? `[MEMÓRIAS DISTANTES — use "lembro vagamente que..." ao citar]\n${memory.ashes.block}` : ''}
[EVENTOS]\n${truncatedEvents}
${onboardingState?.status !== 'completed' ? buildOnboardingBlock(onboardingState) : ''}
${gapsBlock}
${principlesText ? `[BÚSSOLA]\n${principlesText}` : ''}
${dynamicGuidelines ? `[DIRETRIZES DA INSTÂNCIA ATIVA]\n${dynamicGuidelines}` : ''}
${intent === 'focus' ? `\n[MODO SUPORTE EXECUTIVO ATIVADO]\nO usuário demonstrou sinais de paralisia, TDAH ou sobrecarga. SEJA EXTREMAMENTE DIRETIVO. Sem preâmbulos. Fale frases curtas. Dê apenas o PRÓXIMO PASSO IMEDIATO. Sugira a ferramenta 'quebrar_tarefa' se for algo complexo.` : ''}

REGRAS OPERACIONAIS:
FOCO: Responda o que foi perguntado. Nunca repita sugestão já rejeitada.
MODO DE RESPOSTA:
- Pergunta factual/procedural: Responda imediatamente. Sem preâmbulo.
- Desabafo/observação sem pedido implícito: Acolha em 1 frase. Não pergunte nada.
- Pergunta ambígua: resolve pela interpretação mais provável. Mencione ao final.
PROIBIDO em qualquer resposta:
- Preâmbulos ("Claro!", "Boa pergunta!")
- Resumir o que o usuário acabou de dizer antes de responder
- Múltiplas perguntas de volta
CONTEXTO PESSOAL: Use memórias naturalmente.
PROIBIDO: "Anota aí", "Anotado!", "Registrado!". Se salvou via ferramenta: "Feito." ou "Tá na agenda."
MEMÓRIA: Nunca diga "Tenho uma nota aqui que diz...".
FAMÍLIA: Nunca assuma que mãe/pai de um filho é o cônjuge atual.
LEMBRETES: Se usar "me lembra", chame OBRIGATORIAMENTE a tool create_reminder.
FINANÇAS: Valores monetários com ação (gastei, paguei) = registrar_transacao.
COMPROMISSOS: Data/hora específica = salvar_evento E create_reminder.
DATAS SEM HORA: Apenas salvar_evento.
PERGUNTA PENDENTE: ${userRecord.pending_question ? `Você fez esta pergunta: "${userRecord.pending_question}". Processe e limpe a pendência.` : 'Nenhuma.'}
Ao agendar:
- Se cair em feriado ou fim de semana, avise.
CLASSIFICAÇÃO: Ao final inclua obrigatoriamente [CLASSE: info] ou [CLASSE: noise].`.trim();

    const conversationMessages: any[] = [
      { role: 'system', content: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] },
      ...(memory.ram.ramBlock ? [{ role: 'system', content: memory.ram.ramBlock }] : []),
      ...memory.ram.recentPairs,
      { role: 'user', content: messageText },
    ];

    if (/ignore isso|ignora isso|apaga isso/i.test(messageText)) {
      const { data: last } = await supabase.schema('jarvis').from('brain').select('id').eq('user_id', numericUserIdStr).order('created_at', { ascending: false }).limit(1).single();
      if (last) await supabase.schema('jarvis').from('brain').delete().eq('id', last.id);
      return NextResponse.json({ reply: 'Feito — apaguei o que foi dito antes. 🗑️', sessionId, ok: true });
    }

    if (/o que (você|vc) (sabe|conhece)/i.test(messageText)) {
      conversationMessages.push({ role: 'system', content: `[AUTO-DESCOBERTA] V8.13.3 com Gatekeeper, MemoryManager e Graceful Degradation.` });
    }
    conversationMessages.push({ role: 'system', content: `[INTERNO] Responda APENAS o que foi perguntado. NUNCA diga "Anotado!".` });

    // ========== 4. Gatekeeper e LLM ==========
    const isGeminiPro = modelRoute.model.includes('gemini-2.5-pro');
    let maxTokens = isLikelyNoise ? 250 : (isGeminiPro ? 4096 : 2500);
    let finalResponse = '';
    let attempts = 0;
    let forcedToolChoice: any = /me lembra|avisa/i.test(messageText) ? { type: 'function', function: { name: 'create_reminder' } } : intent === 'calendar' ? { type: 'function', function: { name: 'salvar_evento' } } : 'auto';

    while (attempts < 5) {
      const response = await callOpenRouterWithPriority(
        1, 'never', `chat_${msg_id}`,
        conversationMessages, tools, modelRoute.model,
        Math.min(1.0, temperature + adaptiveTempOffset), 35000,
        Math.round(maxTokens * adaptiveMaxTokensMultiplier), forcedToolChoice
      );

      const { content, toolCalls } = response as any;

      if (!toolCalls?.length && content) {
        finalResponse = content;
        break;
      }

      if (toolCalls?.length) {
        forcedToolChoice = 'auto';
        conversationMessages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });

        for (const toolCall of toolCalls) {
          try {
            const result = await executeTool(toolCall, authUserId, numericUserIdStr);
            conversationMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
          } catch (toolError: any) {
            conversationMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: toolError.message }) });
          }
        }
      } else {
        finalResponse = content || "Concluí a anotação internamente. Posso ajudar com mais alguma coisa?";
        break;
      }

      attempts++;
    }

    if (!finalResponse || finalResponse === 'Processamento concluído.') {
      const finalPick = await callOpenRouterWithPriority(
        1, 'never', `final_${msg_id}`,
        [
          ...conversationMessages, 
          { role: 'system', content: 'Resuma o que foi feito de forma humana para o usuário em 1 ou 2 frases curtas, confirmando que os dados foram salvos ou processados.' }
        ],
        [], modelRoute.model, 0.5, 10000, 200
      );
      finalResponse = (finalPick as any).content || 'Pronto, Célio. Já deixei tudo organizado para você.';
    }
    
    let category = 'info';
    if (finalResponse.match(/\[CLASSE:\s*(\w+)\]/i)) category = finalResponse.match(/\[CLASSE:\s*(\w+)\]/i)![1].toLowerCase();
    finalResponse = sanitizeSensitiveData(finalResponse.replace(/\[CLASSE:.*?\]|\[INTERNO:.*?\]/gi, '').trim());

    if (userRecord.pending_question) await clearPendingQuestion(numericUserIdStr);

    // ========== 5. RAM Sync (Ponto de não-retorno) ==========
    try {
      const brainWrite = MemoryManager.write({
        type: 'conversation', userId: numericUserIdStr, sessionId, messageText, aiReply: finalResponse,
        category, embedding: queryEmbedding || undefined, metadata: { msg_id, model: modelRoute.model }
      });
      await Promise.race([brainWrite, new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), BRAIN_SYNC_TIMEOUT_MS))]);
    } catch { console.warn(`[Sync] Timeout para ${msg_id}.`); }

    // ========== 6. Despacho Assíncrono (QStash) ==========
    if (!isLikelyNoise) {
      const qstashPayload = {
        msg_id, userId: numericUserIdStr, authorName, assistantName, sessionId,
        message: messageText, reply: finalResponse, contexts: detectedContexts,
        emotional, modelRoute: modelRoute.model
      };

      const qstashBaseUrl = process.env.QSTASH_URL || 'https://qstash.upstash.io';
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '');
      const targetUrl = encodeURIComponent(`${appUrl}/api/jobs-processor`);

      fetch(`${qstashBaseUrl}/v2/publish/${targetUrl}`, {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${process.env.QSTASH_TOKEN}`, 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify(qstashPayload)
      }).catch(e => console.error('[QStash] Erro ao despachar:', e));
    }

    // --- BLOCO DE NOTIFICAÇÕES PENDENTES E RESPOSTA FINAL ---
    const pendingNotifKey = `pending_notification_${numericUserIdStr}`;
    try {
      const pendingNotif = await redis.get<string>(pendingNotifKey);
      if (pendingNotif && !isLikelyNoise) { 
        finalResponse = finalResponse.trimEnd() + '\n\n' + pendingNotif; 
        await redis.del(pendingNotifKey); 
      }
    } catch (e) {
      console.warn('[Redis] Erro ao buscar notificações pendentes:', e);
    }

    console.log(`[Performance] Total Rota: ${Date.now() - totalStartTime}ms`);
    
    return NextResponse.json({ 
      reply: finalResponse, 
      sessionId, 
      assistantName, 
      authorName, 
      ok: true 
    });

  } catch (error: any) {
    console.error('[chat] ERRO FATAL:', error);
    return NextResponse.json({ 
      error: 'Erro interno no motor do Jarvis.',
      details: error.message 
    }, { status: 500 });
  }
}
