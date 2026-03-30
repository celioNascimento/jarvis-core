// app/api/chat/route.ts
// Motor V8 Unificado — Arquitetura Dual-ID
// ✅ CORREÇÕES APLICADAS: threshold, match_count, logs de debug
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
// ── Módulos locais ────────────────────────────────────────────
import { assertNumericUserId } from '@/lib/chat/guards';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import { ensureMemoryHealth } from '@/lib/chat/event-relevance';
import {
  classifyContextWithL4,
  routeModel,
  getTemperature,
  planContextualBlocks,
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

export const maxDuration = 30;

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
  if (onboardingMemory?.metadata?.state) return onboardingMemory.metadata.state;
  return await initOnboarding(userId);
}

// ============================================================
// POST — Handler Principal
// ============================================================
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

    // ----------------------------------------------------------
    // Parse Híbrido: Áudio (FormData) vs Texto (JSON)
    // ----------------------------------------------------------
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
        const buffer = Buffer.from(await audioFile.arrayBuffer());
        const whisperFormData = new FormData();
        whisperFormData.append('file', new Blob([buffer]), 'audio.ogg');
        whisperFormData.append('model', 'whisper-1');
        whisperFormData.append('language', 'pt');

        const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: whisperFormData,
        });

        if (!whisperRes.ok)
          return NextResponse.json({ error: 'Falha na transcrição' }, { status: 500 });
        const whisperData = await whisperRes.json();
        messageText = whisperData.text?.trim() || '';
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

    // ----------------------------------------------------------
    // Lookup do usuário — aceita email OU userId
    // ----------------------------------------------------------
    let userRecord: any = null;

    if (userEmail) {
      const { data } = await supabase
        .from('users')
        .select('id, nickname, current_context, assistant_name, timezone, pending_question, pending_context')
        .eq('email', userEmail)
        .maybeSingle();
      userRecord = data;
    }

    if (!userRecord && tempUserId) {
      const isNumeric = /^\d+$/.test(tempUserId);
      if (isNumeric) {
        const { data } = await supabase
          .from('users')
          .select('id, nickname, current_context, assistant_name, timezone, pending_question, pending_context')
          .eq('id', tempUserId)
          .maybeSingle();
        userRecord = data;
      } else {
        console.warn('[chat] tempUserId é UUID do Auth:', tempUserId);
        const { data } = await supabase
          .from('users')
          .select('id, nickname, current_context, assistant_name, timezone, pending_question, pending_context')
          .eq('auth_user_id', tempUserId)
          .maybeSingle();
        userRecord = data;
      }
    }

    if (!userRecord)
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });

    // ----------------------------------------------------------
    // DUAL-ID
    // ----------------------------------------------------------
    const numericUserIdStr = String(userRecord.id);
    assertNumericUserId(numericUserIdStr, 'POST /api/chat — numericUserIdStr');

    let authUserId: string = numericUserIdStr;

    if (userEmail) {
      try {
        const { data: authData } = await supabase.auth.admin.getUserByEmail(userEmail);
        if (authData?.user?.id) {
          authUserId = authData.user.id;
          console.log('[chat] authUserId via email:', authUserId);
        }
      } catch (e) {
        console.warn('[chat] Falha ao buscar authUserId via email:', e);
      }
    }

    if (authUserId === numericUserIdStr && tempUserId) {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tempUserId);
      if (isUUID) {
        authUserId = tempUserId;
        console.log('[chat] authUserId via tempUserId UUID:', authUserId);
      }
    }

    if (authUserId === numericUserIdStr)
      console.warn('[chat] authUserId não resolvido — listas/lugares podem não funcionar.');

    const authorName = userRecord.nickname || userFirstName;
    const assistantName = userRecord.assistant_name || 'Lev';
    const userTimezone = userRecord.timezone || 'America/Sao_Paulo';
    const currentContextL3 = userRecord.current_context || 'Sem dossiê ainda.';
    const pendingQuestion = userRecord.pending_question || null;

    ensureMemoryHealth(numericUserIdStr).catch((e) => console.error('[Health]', e));

    const sessionId = clientSessionId || (await getOrCreateSession(numericUserIdStr));
    console.log('[chat] sessionId:', sessionId);

    // ----------------------------------------------------------
    // Localização
    // ----------------------------------------------------------
    let locationContext = '';
    if (location) {
      const { latitude, longitude } = location;
      const endereco = await checkProximidade(latitude, longitude);
      locationContext = `${endereco}\nCoordenadas exatas: ${latitude}, ${longitude}`;
      await supabase.from('config').upsert(
        { key: `last_location_${numericUserIdStr}`, value: JSON.stringify({ latitude, longitude, endereco, ts: Date.now() }) },
        { onConflict: 'key' }
      );
      const alertaGeo = await verificarAlertasDeProximidade(authUserId, latitude, longitude);
      if (alertaGeo.temAlerta)
        return NextResponse.json({ reply: alertaGeo.mensagem, sessionId, ok: true });
      if (!messageText) messageText = '[Enviou Localização]';
    } else {
      const { data: lastLoc } = await supabase
        .from('config').select('value').eq('key', `last_location_${numericUserIdStr}`).single();
      if (lastLoc?.value) {
        try {
          const loc = JSON.parse(lastLoc.value);
          const idadeMinutos = (Date.now() - loc.ts) / 60000;
          if (idadeMinutos <= 60)
            locationContext = `${loc.endereco}\nCoordenadas: ${loc.latitude}, ${loc.longitude} (há ${Math.round(idadeMinutos)} min)`;
        } catch { /* ignore */ }
      }
    }

    // ----------------------------------------------------------
    // Classificação, roteamento e tópicos
    // ----------------------------------------------------------
    console.time('[Performance] context_classification');
    const detectedContexts = await classifyContextWithL4(messageText, numericUserIdStr);
    console.timeEnd('[Performance] context_classification');

    const modelRoute = routeModel(detectedContexts);
    const temperature = getTemperature(detectedContexts);
    const blockPlan = planContextualBlocks(detectedContexts);
    console.log('[chat] contexts:', detectedContexts, '| model:', modelRoute.label);

    await updateTopicIndex(numericUserIdStr, detectedContexts, messageText);
    const relatedTopicsBlock = await getRelatedTopics(numericUserIdStr, detectedContexts[0] || 'casual');

    // ----------------------------------------------------------
    // Pesquisa forçada
    // ----------------------------------------------------------
    let forcedSearchResult = '';
    if (shouldForceSearch(messageText, detectedContexts)) {
      const searchQuery = refineSearchQuery(messageText, detectedContexts);
      console.log('[chat] ForcedSearch:', searchQuery);
      try {
        const result = await searchWeb(searchQuery);
        forcedSearchResult = `\n[PESQUISA AUTOMÁTICA REALIZADA]\nConsulta: "${searchQuery}"\nResultado:\n${result}`;
      } catch (e) {
        console.error('[chat] ForcedSearch falhou:', e);
        forcedSearchResult = '\n[ERRO NA PESQUISA] Não foi possível obter informações atualizadas.';
      }
    }

    // ----------------------------------------------------------
    // Cargas contextuais paralelas
    // ----------------------------------------------------------
    const basePromises = Promise.all([
      supabase.from('events').select('title, event_date, category, decay_type, relevance_score, emotional_weight, is_recurring, notes').eq('user_id', numericUserIdStr).order('relevance_score', { ascending: false }),
      supabase.from('memory_ashes').select('ash_summary, period_start, period_end').eq('user_id', numericUserIdStr).order('period_end', { ascending: false }).limit(5),
      supabase.from('onboarding_progress').select('*').eq('user_id', numericUserIdStr).single(),
      buildGapsBlock(numericUserIdStr, messageText),
      supabase.from('principles').select('content, category').order('created_at', { ascending: true }),
    ]);

    const conditionalTasks: Promise<any>[] = [];
    if (blockPlan.loadCalendar) {
      conditionalTasks.push(getGoogleContext().catch(() => null));
      conditionalTasks.push(getMicrosoftCalendarContext().catch(() => null));
    }
    if (blockPlan.loadEmail) conditionalTasks.push(getRecentEmails(undefined, 3, false).catch(() => null));
    if (blockPlan.loadTopics) conditionalTasks.push(buildTopicBlock(numericUserIdStr, messageText).catch(() => ''));
    if (blockPlan.loadDiary) conditionalTasks.push(buildDiaryGoalsBlock(numericUserIdStr).catch(() => ''));

    const [[eventsResult, ashesResult, onboardingResult, gapsBlock, principlesResult], conditionalResults] =
      await Promise.all([basePromises, Promise.all(conditionalTasks)]);

    let ri = 0;
    const googleCtx = blockPlan.loadCalendar ? conditionalResults[ri++] : null;
    const msCtx = blockPlan.loadCalendar ? conditionalResults[ri++] : null;
    const emailBlock = blockPlan.loadEmail ? conditionalResults[ri++] : null;
    const topicBlock = blockPlan.loadTopics ? conditionalResults[ri++] || '' : '';
    const diaryBlock = blockPlan.loadDiary ? conditionalResults[ri++] || '' : '';

    const recsBlock = blockPlan.loadRecommendations
      ? await buildRecommendationsBlock(numericUserIdStr, messageText).catch(() => '')
      : '';

    const principles = principlesResult?.data || [];
    const principlesBlock = principles.length > 0 ? principles.map((p: any) => `- ${p.content}`).join('\n') : '';

    let onboardingState = onboardingResult?.data || null;
    if (!onboardingState) onboardingState = await getOrCreateOnboardingStatePersistent(numericUserIdStr);
    const onboardingBlock = buildOnboardingBlock(onboardingState);

    const events = eventsResult.data || [];
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

    const ashes = ashesResult.data || [];
    const ashesBlock = ashes.length > 0 ? ashes.map((a: any) => a.ash_summary).join('\n') : null;

    let personNotesBlock = '';
    const [childrenResult, personNotesResult] = await Promise.all([
      supabase.from('children').select('name, nickname, lev_notes').eq('parent_id', numericUserIdStr).not('lev_notes', 'is', null),
      supabase.from('person_notes').select('person_name, person_type, note, noted_at').eq('user_id', numericUserIdStr).order('noted_at', { ascending: false }).limit(20),
    ]);
    const msgLower = messageText.toLowerCase();
    const childNotes = (childrenResult.data || []).filter(
      (c: any) => msgLower.includes((c.nickname || '').toLowerCase()) || msgLower.includes((c.name || '').split(' ')[0].toLowerCase())
    );
    const pNotes = (personNotesResult.data || []).filter((n: any) =>
      n.person_name.toLowerCase().split(' ').some((p: string) => p.length >= 3 && new RegExp(`\\b${p}\\b`).test(msgLower))
    );

    if (childNotes.length > 0 || pNotes.length > 0) {
      const lines: string[] = [];
      for (const c of childNotes) lines.push(`${c.nickname || c.name.split(' ')[0]}: ${c.lev_notes}`);
      for (const n of pNotes) lines.push(`${n.person_name} [${n.noted_at}]: ${n.note}`);
      personNotesBlock = `[NOTAS SOBRE PESSOAS MENCIONADAS]\n${lines.join('\n')}`;
    }

    // ----------------------------------------------------------
    // ✅ BUSCA DE MEMÓRIAS HD — CORREÇÕES APLICADAS
    // ----------------------------------------------------------
    const queryEmbedding = await getCachedEmbedding(messageText);
    let hdBlock = '';
    let hdMemoryIds: string[] = [];
    
    if (queryEmbedding) {
      console.log('[Embedding] Gerado com sucesso, dimensões:', queryEmbedding.length);
      
      const { data: search, error } = (await supabase.rpc('match_memories', {
        query_embedding: queryEmbedding, 
        match_threshold: 0.28,  // ✅ DE 0.4 PARA 0.28
        match_count: 8,         // ✅ DE 3 PARA 8
      })) as { data: any[] | null; error?: any };
      
      if (error) {
        console.error('[Memória HD] Erro na RPC:', error);
      } else if (search?.length) {
        console.log('[Memória HD]', search.length, 'memórias encontradas');
        console.log('[Scores]', search.map((r: any) => `${r.summary.substring(0, 50)}... = ${r.similarity.toFixed(3)}`));
        
        hdBlock = search.filter((r: any) => !r.summary.startsWith('[CINZA]')).map((r: any) => r.summary).join('\n---\n');
        hdMemoryIds = search.map((r: any) => r.id);
      } else {
        console.warn('[Memória HD] Nenhuma memória encontrada — threshold 0.28 pode ainda estar alto');
      }
    } else {
      console.error('[Embedding] Falha ao gerar embedding');
    }

    // ----------------------------------------------------------
    // Memória RAM (histórico da sessão)
    // ----------------------------------------------------------
    let ramBlock = '';
    const { data: historySession } = await supabase
      .from('brain').select('content, metadata').eq('user_id', numericUserIdStr).eq('session_id', sessionId).neq('category', 'archived').order('created_at', { ascending: false }).limit(10);

    const topicShifted = await detectTopicShiftWithL4(numericUserIdStr, detectedContexts);

    if (historySession && historySession.length >= 2) {
      if (topicShifted) {
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
      const semanticBlock = await semanticRamCompression(historySession || [], numericUserIdStr, messageText, queryEmbedding);
      ramBlock = semanticBlock || (hdBlock ? `[Contexto anterior consolidado]\n${hdBlock}` : ' ');
    }
    if (ramBlock.length > RAM_MAX_CHARS) ramBlock = ramBlock.slice(-RAM_MAX_CHARS);

    const weights = classifyTemporalHorizon(messageText, ramBlock, pendingQuestion);
    const truncatedL3 = truncateByWeight(currentContextL3, weights.l3, 6000);
    const truncatedHd = truncateByWeight(hdBlock, weights.hd, 6000);
    const truncatedAshes = ashesBlock ? truncateByWeight(ashesBlock, weights.ashes, 6000) : null;
    const truncatedEvents = truncateByWeight(eventsBlock, weights.events, 6000);
    const fusoHorario = new Date().toLocaleString('pt-BR', { timeZone: userTimezone });

    const isFemale = currentContextL3.toLowerCase().includes('feminino') || currentContextL3.toLowerCase().includes('mulher');
    const informalAddress = isFemale ? 'miga' : 'cara';

    // ----------------------------------------------------------
    // System Prompt
    // ----------------------------------------------------------
    const systemPrompt = `Você é ${assistantName}, assistente pessoal de ${authorName}.
Data/hora: ${fusoHorario} | Modo: ${weights.horizon.toUpperCase()}
🚨 REGRA ABSOLUTA – PESQUISE SEMPRE! 🚨
Para QUALQUER pergunta sobre jogos, resultados esportivos, datas de eventos, notícias, cotações, clima em outras cidades — chame \`searchWeb\` ANTES de responder.
ATENÇÃO: Se "[PESQUISA AUTOMÁTICA REALIZADA]" estiver presente, use como fonte principal.
${forcedSearchResult}
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
${principlesBlock ? `[BÚSSOLA]\n${principlesBlock}` : ''}
REGRAS COMPORTAMENTAIS:
FOCO: Responda O QUE FOI PERGUNTADO. Nunca repita sugestão rejeitada.
TOM: Amigo inteligente, direto, humano. Use "${informalAddress}" no máximo 1x por conversa. Nunca comece com "Considerando que".
PROIBIDO: "Anotado!", "Registrado!". Se salvou via ferramenta: "Feito." ou "Tá na agenda."
PRESENÇA EMOCIONAL: Seja empático quando algo difícil for compartilhado.
MEMÓRIA: Use notas naturalmente. Nunca diga "Tenho uma nota aqui que diz...".
FAMÍLIA: Nunca assuma que mãe/pai de um filho é o cônjuge atual.
PERGUNTA PENDENTE: ${pendingQuestion ? `Você fez esta pergunta: "${pendingQuestion}". A mensagem atual é a resposta — processe e limpe a pendência.` : 'Nenhuma.'}
CLASSIFICAÇÃO: Ao final inclua obrigatoriamente [CLASSE: info] ou [CLASSE: noise].`.trim();

    // ----------------------------------------------------------
    // Histórico de conversa
    // ----------------------------------------------------------
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

    // ----------------------------------------------------------
    // ReAct Loop
    // ----------------------------------------------------------
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

    if (!finalResponse && extractionSummary) {
      const feedbacks = ['Certo.', 'Ok.', 'Guardei.', 'Entendido.'];
      finalResponse = feedbacks[Math.floor(Math.random() * feedbacks.length)];
    }

    if (pendingQuestion)
      clearPendingQuestion(numericUserIdStr).catch((e) => console.error('[PendingQ]', e));

    // ----------------------------------------------------------
    // Persistência
    // ----------------------------------------------------------
    const { error: insertError } = await supabase.from('brain').insert([{
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
    return NextResponse.json({ reply: finalResponse, sessionId, ok: true });
  } catch (error: any) {
    console.error('[chat] ERRO:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}