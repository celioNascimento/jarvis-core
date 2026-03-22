import { NextResponse } from 'next/server';
import {
  supabase,
  callOpenRouter,
  generateEmbedding,
  sendTelegram,
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
import { getGoogleContext, createGoogleEvent, updateGoogleEvent, deleteGoogleEvent } from '@/lib/google';
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
// SPRINT 1 — #2 Roteamento de modelo
// ============================================================

type ContextType =
  | 'agenda' | 'projeto' | 'familia' | 'emocao' | 'diario' | 'meta'
  | 'saude' | 'recomendacao' | 'evento' | 'rotina' | 'preferencia'
  | 'alias' | 'email' | 'casual';

/**
 * Classifica o contexto da mensagem via regex — zero latência, sem LLM.
 * Retorna array de contextos detectados (pode ter mais de um).
 */
function classifyContext(text: string): ContextType[] {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const rules: Array<[RegExp, ContextType]> = [
    // Diário / reflexão — antes de emocao para ter prioridade
    [/diario|diário|hoje foi|hoje ta|hoje está|acordei|dormi|dormir|meu dia|como foi meu|reflexao|refletindo|gratid/i, 'diario'],
    // Meta / objetivo
    [/meta|objetivo|quero (conseguir|fazer|terminar|lancar|comecar)|prazo|progresso|etapa|concluir|finalizar/i, 'meta'],
    // Agenda / compromisso com hora
    [/reuniao|reunião|consulta|compromisso|agend|horario|horário|amanha as|amanhã às|segunda|terça|quarta|quinta|sexta|sabado|domingo|às \d|as \d{1,2}h/i, 'agenda'],
    // Projeto / produto
    [/projeto|app|aplicativo|sistema|api|deploy|feature|sprint|mvp|startup|produto|desenvolv/i, 'projeto'],
    // Família
    [/filho|filha|esposa|marido|mae|mãe|pai|irmao|irmão|família|familia|cônjuge|conjuge|casamento|nasceu|aniversario de casamento/i, 'familia'],
    // Saúde
    [/medic|médic|saude|saúde|exame|remedio|remédio|hospital|dor |doenca|doença|sintoma|consulta médica/i, 'saude'],
    // Emoção
    [/sinto|estou (triste|feliz|ansioso|cansado|animado|frustrado|preocupado|deprimido|sozinho)|me sinto|to mal|tô mal|to bem|tô bem|angustia|angústia|estressado/i, 'emocao'],
    // Email
    [/email|e-mail|inbox|caixa de entrada|mensagem do|mensagem da|enviou|recebeu/i, 'email'],
    // Recomendação
    [/indica|recomend|sugere|onde posso|tem algum|onde tem|restaurante|lugar|lugar bom|conhece algum/i, 'recomendacao'],
    // Evento / data comemorativa (sem hora)
    [/aniversario|aniversário|natal|pascoa|páscoa|ano novo|feriado|data importante|comemora/i, 'evento'],
    // Rotina
    [/acordo|desperto|academia|treino|trabalho as|trabalho às|entrada no trabalho|saida do trabalho|rotina|horario de/i, 'rotina'],
    // Preferência
    [/gosto de|nao gosto de|não gosto de|prefiro|adoro|odeio|minha comida|meu filme|minha musica|minha música/i, 'preferencia'],
    // Alias
    [/quando falo em|quando eu falar|pode chamar de|se eu disser|apelido|alias/i, 'alias'],
  ];

  const detected: ContextType[] = [];
  for (const [rx, ctx] of rules) {
    if (rx.test(t)) detected.push(ctx);
  }

  return detected.length > 0 ? detected : ['casual'];
}

// ============================================================
// SPRINT 1 — #2 Roteamento de modelo
// ============================================================

interface ModelRoute {
  model: string;
  label: string;
}

/**
 * Escolhe o modelo com base nos contextos detectados.
 * - Contextos complexos → Sonnet (raciocínio, emoção, projetos)
 * - Contextos simples   → Gemini Flash (custo 10× menor)
 */
function routeModel(contexts: ContextType[]): ModelRoute {
  const complexContexts: ContextType[] = ['agenda', 'projeto', 'familia', 'emocao', 'diario', 'meta', 'saude'];
  const isComplex = contexts.some(c => complexContexts.includes(c));

  if (isComplex) {
    return { model: 'anthropic/claude-sonnet-4-5', label: 'sonnet' };
  }

  return { model: 'google/gemini-2.0-flash-001', label: 'flash' };
}

// ============================================================
// SPRINT 1 — #4 Temperatura adaptativa
// ============================================================

/**
 * Define a temperatura com base no contexto emocional/factual da mensagem.
 * - Factual (agenda, evento, email) → 0.3 — respostas precisas
 * - Neutro (rotina, alias, preferencia) → 0.5
 * - Casual, projeto → 0.7
 * - Emocional (emoção, diário, reflexão) → 0.9 — mais criativo e humano
 */
function getTemperature(contexts: ContextType[]): number {
  if (contexts.some(c => ['emocao', 'diario'].includes(c))) return 0.9;
  if (contexts.some(c => ['casual', 'projeto', 'familia', 'meta'].includes(c))) return 0.7;
  if (contexts.some(c => ['rotina', 'alias', 'preferencia', 'recomendacao'].includes(c))) return 0.5;
  if (contexts.some(c => ['agenda', 'evento', 'email', 'saude'].includes(c))) return 0.3;
  return 0.7;
}

// ============================================================
// SPRINT 1 — #3 Injeção contextual
// ============================================================

interface ContextualBlocks {
  topicBlock: string;
  diaryGoalsBlock: string;
  recommendationsBlock: string;
  needsCalendar: boolean;   // sinaliza para carregar Google + Outlook
  needsEmail: boolean;      // sinaliza para carregar emails
}

/**
 * Decide quais blocos extras carregar com base nos contextos.
 * Blocos caros (calendário, email) só são buscados quando realmente necessários.
 */
function planContextualBlocks(contexts: ContextType[]): {
  loadTopics: boolean;
  loadDiary: boolean;
  loadRecommendations: boolean;
  loadCalendar: boolean;
  loadEmail: boolean;
} {
  return {
    loadTopics:          contexts.some(c => ['saude', 'projeto', 'familia', 'casual', 'rotina', 'preferencia'].includes(c)),
    loadDiary:           contexts.some(c => ['diario', 'meta', 'emocao', 'casual'].includes(c)),
    loadRecommendations: contexts.some(c => ['recomendacao', 'casual'].includes(c)),
    loadCalendar:        contexts.some(c => ['agenda', 'evento', 'familia'].includes(c)),
    loadEmail:           contexts.some(c => ['email'].includes(c)),
  };
}

// ============================================================
// WEBHOOK PRINCIPAL
// ============================================================

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const message = body.message;
    let messageText = message?.text || "";

    // ============================================================
    // WHISPER — transcrição de áudio
    // ============================================================
    if (message?.voice) {
      try {
        const fileId = message.voice.file_id;
        const getFile = await fetch(
          `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
        );
        const fileData = await getFile.json();

        if (!fileData.ok) {
          await sendTelegram(message.chat.id, "⚠️ Não consegui acessar o áudio. Tenta de novo?");
          return NextResponse.json({ ok: true });
        }

        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileData.result.file_path}`;
        const audioRes = await fetch(fileUrl);

        if (!audioRes.ok) {
          await sendTelegram(message.chat.id, "⚠️ Falha ao baixar o áudio. Tenta de novo?");
          return NextResponse.json({ ok: true });
        }

        const buffer = await audioRes.arrayBuffer();
        const audioFormats = [
          { type: 'audio/mpeg', ext: 'voice.mp3' },
          { type: 'audio/ogg',  ext: 'voice.ogg' },
          { type: 'audio/wav',  ext: 'voice.wav' },
        ];

        let transcriptionRes: Response | null = null;
        for (const fmt of audioFormats) {
          const formData = new FormData();
          formData.append('file', new Blob([buffer], { type: fmt.type }), fmt.ext);
          formData.append('model', 'whisper-1');
          formData.append('language', 'pt');

          const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
            body: formData
          });

          if (res.ok) { transcriptionRes = res; break; }
        }

        if (!transcriptionRes) {
          await sendTelegram(message.chat.id, "⚠️ Não consegui transcrever o áudio. Pode digitar?");
          return NextResponse.json({ ok: true });
        }

        const transcriptionData = await transcriptionRes.json();
        messageText = transcriptionData.text?.trim() || "";

        if (!messageText) {
          await sendTelegram(message.chat.id, "⚠️ O áudio veio vazio. Pode repetir?");
          return NextResponse.json({ ok: true });
        }

      } catch (err) {
        console.error("Erro no pipeline de áudio:", err);
        await sendTelegram(message.chat.id, "⚠️ Erro ao processar áudio. Tenta digitar.");
        return NextResponse.json({ ok: true });
      }
    }

    const chatId         = message?.chat?.id;
    const telegramUserId = message?.from?.id;
    const userFirstName  = message?.from?.first_name || "Usuário";
    const stringId       = String(telegramUserId);

    // ============================================================
    // SPRINT 1 — classifica contexto logo no início
    // Todas as decisões de modelo, blocos e temperatura dependem disso.
    // ============================================================
    const detectedContexts = classifyContext(messageText);
    const modelRoute       = routeModel(detectedContexts);
    const temperature      = getTemperature(detectedContexts);
    const blockPlan        = planContextualBlocks(detectedContexts);

    console.log(`[Sprint1] contextos: ${detectedContexts.join(',')} | modelo: ${modelRoute.label} | temp: ${temperature}`);

    // ============================================================
    // LOCALIZAÇÃO
    // ============================================================
    let locationContext = "";

    if (message?.location) {
      const { latitude, longitude } = message.location;
      console.log('[Geo] Coordenadas recebidas:', { latitude, longitude });
      const endereco = await checkProximidade(latitude, longitude);
      console.log('[Geo] Resultado de checkProximidade:', endereco || '(string vazia)');
      locationContext = `${endereco}\nCoordenadas exatas: ${latitude}, ${longitude}`;

      await supabase.from('config').upsert(
        { key: `last_location_${stringId}`, value: JSON.stringify({ latitude, longitude, endereco, ts: Date.now() }) },
        { onConflict: 'key' }
      );

      const alertaGeo = await verificarAlertasDeProximidade(stringId, latitude, longitude);
      if (alertaGeo.temAlerta) {
        await sendTelegram(chatId ?? message.chat.id, alertaGeo.mensagem);
        return NextResponse.json({ ok: true });
      }

      if (!messageText) messageText = "[Enviou Localização]";

    } else {
      const { data: lastLoc } = await supabase
        .from('config').select('value')
        .eq('key', `last_location_${stringId}`).single();

      if (lastLoc?.value) {
        try {
          const loc = JSON.parse(lastLoc.value);
          const idadeMinutos = (Date.now() - loc.ts) / 60000;
          if (idadeMinutos <= 60) {
            locationContext = `${loc.endereco}\nCoordenadas exatas: ${loc.latitude}, ${loc.longitude} (compartilhada há ${Math.round(idadeMinutos)} min)`;
          }
        } catch {
          console.warn('[Geo] Erro ao parsear localização persistida');
        }
      }
    }

    if (!messageText || chatId == null || telegramUserId == null) {
      return NextResponse.json({ ok: true });
    }

    // ============================================================
    // SPRINT 1 — #3 Busca paralela CONTEXTUAL
    // Blocos caros (calendário, email, recomendações, diary) só são
    // buscados quando o contexto da mensagem realmente pede.
    // ============================================================

    // Bloco base — sempre necessário
    const basePromises = Promise.all([
      supabase
        .from('users')
        .select('nickname, current_context, pending_question, pending_context, plan, assistant_name, timezone, telegram_chat_id')
        .eq('id', stringId).single(),

      getOrCreateSession(stringId),

      supabase
        .from('events')
        .select('title, event_date, category, decay_type, relevance_score, emotional_weight, is_recurring, notes')
        .eq('user_id', stringId).order('relevance_score', { ascending: false }),

      supabase
        .from('memory_ashes')
        .select('ash_summary, period_start, period_end')
        .eq('user_id', stringId).order('period_end', { ascending: false }).limit(5),

      supabase
        .from('onboarding_progress')
        .select('*').eq('user_id', stringId).single(),

      buildGapsBlock(stringId, messageText),

      supabase
        .from('principles')
        .select('content, category').order('created_at', { ascending: true }),
    ]);

    // Blocos condicionais — só busca o que o contexto pede
    const conditionalPromises = Promise.all([
      blockPlan.loadCalendar ? getGoogleContext()              : Promise.resolve(null),
      blockPlan.loadCalendar ? getMicrosoftCalendarContext()   : Promise.resolve(null),
      blockPlan.loadEmail    ? getRecentEmails(undefined, 3, false) : Promise.resolve(null),
      blockPlan.loadTopics   ? buildTopicBlock(stringId, messageText) : Promise.resolve(''),
      blockPlan.loadDiary    ? buildDiaryGoalsBlock(stringId)  : Promise.resolve(''),
    ]);

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
      [
        googleContextBlock,
        microsoftContextBlock,
        emailRadarBlock,
        topicBlock,
        diaryGoalsBlock,
      ]
    ] = await Promise.all([basePromises, conditionalPromises]);

    // Recomendações — também condicional, mas depende de messageText, então separado
    const recommendationsBlock = blockPlan.loadRecommendations
      ? await buildRecommendationsBlock(stringId, messageText)
      : '';

    // ============================================================
    // DEBUG — APIs externas
    // ============================================================
    const isGoogleError    = typeof googleContextBlock    === 'string' && googleContextBlock.includes('Erro');
    const isMicrosoftError = typeof microsoftContextBlock === 'string' && microsoftContextBlock.includes('Erro');
    const isEmailError     = typeof emailRadarBlock       === 'string' && emailRadarBlock?.includes('Erro');

    if (isGoogleError)    console.warn('[Debug] Agenda Google com erro — bloqueada do prompt');
    if (isMicrosoftError) console.warn('[Debug] Agenda Microsoft com erro — bloqueada do prompt');
    if (isEmailError)     console.warn('[Debug] Email radar com erro — bloqueado do prompt');

    const cleanGoogleContext    = isGoogleError    ? null : googleContextBlock;
    const cleanMicrosoftContext = isMicrosoftError ? null : microsoftContextBlock;
    const cleanEmailRadarBlock  = isEmailError     ? null : emailRadarBlock;

    const userProfile   = userProfileResult.data;
    const authorName    = userProfile?.nickname || userFirstName;
    const assistantName = userProfile?.assistant_name || 'Lev';
    const userTimezone  = userProfile?.timezone || 'America/Sao_Paulo';

    if (!userProfile?.telegram_chat_id && chatId) {
      await supabase.from('users').update({ telegram_chat_id: String(chatId) }).eq('id', stringId);
    }

    const currentContextL3 = userProfile?.current_context || "Sem dossiê ainda.";
    const pendingQuestion  = userProfile?.pending_question || null;
    const pendingContext   = userProfile?.pending_context  || null;

    const principles = principlesResult?.data || [];
    const principlesBlock = principles.length > 0
      ? principles.map((p: any) => `- ${p.content}`).join('\n')
      : '';

    const isFemale = currentContextL3.toLowerCase().includes('feminino') ||
                     currentContextL3.toLowerCase().includes('mulher');
    const informalAddress = isFemale ? 'miga' : 'cara';

    let onboardingState = onboardingResult?.data || null;
    if (!onboardingState) onboardingState = await initOnboarding(stringId);
    const onboardingBlock = buildOnboardingBlock(onboardingState);

    // ============================================================
    // EVENTOS
    // ============================================================
    const events       = eventsResult.data || [];
    const urgentEvents = events.filter(e => (e.relevance_score || 0) >= 0.7);
    const radarEvents  = events.filter(e => (e.relevance_score || 0) >= 0.3 && (e.relevance_score || 0) < 0.7);
    const eventsBlock  = events.length > 0 ? [
      urgentEvents.length > 0
        ? `🔴 PRÓXIMOS:\n${urgentEvents.map(e => `  - ${e.title}: ${e.event_date}${e.notes ? ` (${e.notes})` : ''}`).join('\n')}`
        : null,
      radarEvents.length > 0
        ? `🟡 NO RADAR:\n${radarEvents.map(e => `  - ${e.title}: ${e.event_date}`).join('\n')}`
        : null,
    ].filter(Boolean).join('\n\n') : "Nenhum evento cadastrado.";

    const ashes      = ashesResult.data || [];
    const ashesBlock = ashes.length > 0 ? ashes.map(a => a.ash_summary).join('\n') : null;

    // ============================================================
    // NOTAS CONTEXTUAIS
    // ============================================================
    let personNotesBlock = "";
    const [childrenResult, personNotesResult] = await Promise.all([
      supabase.from('children').select('name, nickname, lev_notes')
        .eq('parent_id', stringId).not('lev_notes', 'is', null),
      supabase.from('person_notes').select('person_name, person_type, note, noted_at')
        .eq('user_id', stringId).order('noted_at', { ascending: false }).limit(20),
    ]);

    const msgLower   = messageText.toLowerCase();
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
      for (const n of pNotes)     lines.push(`${n.person_name} [${n.noted_at}]: ${n.note}`);
      personNotesBlock = `[NOTAS SOBRE PESSOAS MENCIONADAS]\n${lines.join('\n')}`;
    }

    // ============================================================
    // HD VETORIAL
    // ============================================================
    const queryEmbedding = await generateEmbedding(messageText);
    let hdBlock    = "";
    let hdMemoryIds: string[] = [];

    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', {
        query_embedding: queryEmbedding,
        match_threshold: 0.4,
        match_count: 3
      }) as { data: any[] | null };

      if (search && search.length > 0) {
        hdBlock     = search.filter(r => !r.summary.startsWith('[CINZA]')).map(r => r.summary).join('\n---\n');
        hdMemoryIds = search.map(r => r.id);
      }
    }

    // ============================================================
    // SPRINT 1 — #5 RAM COMPRIMIDA
    // Detecta mudança de assunto e comprime bloco anterior.
    // Limite absoluto: ~2000 tokens (~8000 chars).
    // ============================================================
    const RAM_MAX_CHARS  = 8000;
    const RAM_FULL_MSGS  = 10;   // mesmo assunto: mantém até 10 trocas brutas
    const RAM_SHIFT_MSGS = 3;    // assunto mudou: mantém só as 3 últimas + resumo

    function topicShifted(history: any[], currentCtxs: ContextType[]): boolean {
      if (history.length < 3) return false;
      const recentCtxs = history.slice(0, 3).flatMap(
        (h: any) => (h.metadata?.contexts_detected as ContextType[] | undefined) || []
      );
      if (recentCtxs.length === 0) return false;
      const overlap = currentCtxs.filter(c => recentCtxs.includes(c));
      return overlap.length === 0 && !currentCtxs.includes('casual');
    }

    function compressToSummary(history: any[]): string {
      const topics = history
        .flatMap((h: any) => (h.metadata?.contexts_detected as string[] | undefined) || [])
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(', ');
      return topics
        ? `[Resumo do assunto anterior: ${topics}]`
        : '[Contexto anterior resumido]';
    }

    let ramBlock = "";

    const { data: historySession } = await supabase
      .from('brain').select('content, metadata')
      .eq('user_id', stringId).eq('session_id', sessionId)
      .neq('category', 'archived').order('created_at', { ascending: false }).limit(RAM_FULL_MSGS);

    if (historySession && historySession.length >= 2) {
      const shifted = topicShifted(historySession, detectedContexts);

      if (shifted) {
        const summary   = compressToSummary(historySession.slice(RAM_SHIFT_MSGS));
        const recentRaw = [...historySession].slice(0, RAM_SHIFT_MSGS).reverse().map((h: any) => {
          const ai = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
          return `${authorName}: ${h.content}\n${assistantName}: ${ai}`;
        }).join('\n\n');
        ramBlock = `${summary}\n\n${recentRaw}`;
        console.log(`[RAM] Nível 1 — assunto mudou (${detectedContexts.join(',')}) | comprimido: ${historySession.length - RAM_SHIFT_MSGS} msgs → resumo`);
      } else {
        ramBlock = [...historySession].reverse().map((h: any) => {
          const ai = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
          return `${authorName}: ${h.content}\n${assistantName}: ${ai}`;
        }).join('\n\n');
        console.log('[RAM] Nível 1 — sessão:', historySession.length, 'msgs');
      }

    } else {
      const { data: historyRecent } = await supabase
        .from('brain').select('content, metadata')
        .eq('user_id', stringId).neq('category', 'archived')
        .order('created_at', { ascending: false }).limit(12);

      if (historyRecent && historyRecent.length > 0) {
        const sessionSet = new Set((historySession || []).map((h: any) => h.content));
        const extra      = historyRecent.filter((h: any) => !sessionSet.has(h.content));
        const merged     = [...(historySession || []), ...extra].slice(0, RAM_FULL_MSGS);
        ramBlock = [...merged].reverse().map((h: any) => {
          const ai = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
          return `${authorName}: ${h.content}\n${assistantName}: ${ai}`;
        }).join('\n\n');
        console.log('[RAM] Nível 2 — recente:', merged.length, 'msgs');

      } else if (hdBlock) {
        ramBlock = `[Contexto anterior consolidado]\n${hdBlock}`;
        console.log('[RAM] Nível 3 — HD como base');
      }
    }

    // Limite absoluto de tokens na RAM
    if (ramBlock.length > RAM_MAX_CHARS) {
      ramBlock = ramBlock.slice(-RAM_MAX_CHARS);
      console.log(`[RAM] Truncado para ${RAM_MAX_CHARS} chars (limite absoluto)`);
    }

    // ============================================================
    // CLASSIFICADOR TEMPORAL (existente — mantido)
    // ============================================================
    const weights = classifyTemporalHorizon(messageText, ramBlock, pendingQuestion);
    console.log(`[Router] ${weights.horizon} | ${weights.reason}`);

    const truncatedRam    = truncateByWeight(ramBlock,         weights.ram,    6000);
    const truncatedL3     = truncateByWeight(currentContextL3, weights.l3,     6000);
    const truncatedHd     = truncateByWeight(hdBlock,          weights.hd,     6000);
    const truncatedAshes  = ashesBlock ? truncateByWeight(ashesBlock, weights.ashes, 6000) : null;
    const truncatedEvents = truncateByWeight(eventsBlock,      weights.events, 6000);

    // ============================================================
    // SYSTEM PROMPT
    // ============================================================
    const fusoHorario = new Date().toLocaleString('pt-BR', { timeZone: userTimezone });

    const systemPrompt = `
Você é ${assistantName}, assistente pessoal de ${authorName}.
Data/hora: ${fusoHorario} | Modo: ${weights.horizon.toUpperCase()}

${cleanGoogleContext    ? `[AGENDA GOOGLE ATUALIZADA]\n${cleanGoogleContext}`      : ''}
${cleanMicrosoftContext ? `[AGENDA OUTLOOK ATUALIZADA]\n${cleanMicrosoftContext}`  : ''}
${cleanEmailRadarBlock  ? `[RADAR DE EMAILS RELEVANTES]\n${cleanEmailRadarBlock}`  : ''}
${locationContext       ? `\n${locationContext}`                                    : ''}

${truncatedL3 ? `[QUEM É ${authorName.toUpperCase()}]\n${truncatedL3}` : ''}

${personNotesBlock     ? personNotesBlock     : ''}
${recommendationsBlock ? recommendationsBlock : ''}
${topicBlock           ? topicBlock           : ''}
${diaryGoalsBlock      ? diaryGoalsBlock      : ''}

${truncatedHd ? `[MEMÓRIAS DE LONGO PRAZO]\n${truncatedHd}` : ''}

${truncatedAshes ? `[MEMÓRIAS DISTANTES — use "lembro vagamente que..." ao citar]\n${truncatedAshes}` : ''}

${onboardingBlock}
${gapsBlock}

${principlesBlock ? `[BÚSSOLA — seu jeito de ser no mundo, não regras a citar]\n${principlesBlock}` : ''}

REGRAS:
1. FOCO: Responda O QUE FOI PERGUNTADO. Nunca mude de assunto.
   - Pronomes ("esse filme", "isso", "ele") sempre se referem ao ÚLTIMO assunto da conversa
   - Nunca pergunte "qual?" se o histórico já deixa claro
   - NUNCA pergunte sobre projetos, apps ou negócios por iniciativa própria — espere o usuário tocar no assunto
   - "tenta de novo", "outra opção", "não", "não gostei" → sugere algo DIFERENTE imediatamente, sem perguntar
   - NUNCA repita uma sugestão que já foi rejeitada na mesma conversa

2. TOM: Amigo de longa data — inteligente, direto, humano.
   - Use "${informalAddress}" com moderação — no máximo 1x por conversa, nunca para iniciar frase
   - Humor leve e inesperado quando o momento pedir
   - NUNCA comece com "Considerando que", "Com base no seu histórico", "Levando em conta"
   - SEM "Em que posso te ajudar?" ou variações
   - PROIBIDO: "Anotado!", "Registrado!", "Guardei aqui!", "Já registrei" — jamais, em hipótese alguma

3. PRESENÇA EMOCIONAL: Quando ${authorName} compartilhar algo difícil ou delicado, esteja presente.
   - Responda como um amigo que ouviu de verdade — não como um sistema que registrou
   - NUNCA diga "Anotado!", "Registrado!", "Guardei aqui" — o registro acontece por baixo, invisível
   - Para sinalizar que entendeu: "Faz sentido", "Entendi", "Pô...", ou simplesmente continue a conversa
   - AMBIGUIDADE: se não souber o que registrar, pergunte antes. Ex: "Unopar é faculdade ou empresa?"
   - LIMITE: você é um apoio, não um substituto para relações reais. Se o assunto for recorrentemente
     pesado (luto, crise, sofrimento prolongado), acolha e sugira uma pessoa de confiança ou profissional.

4. MEMÓRIA EMOCIONAL: Use as notas sobre pessoas para aprofundar a conversa.
   - Se [NOTAS SOBRE PESSOAS MENCIONADAS] estiver presente, você já conhece a história — não pergunte o que já sabe
   - Quando a pessoa mencionada tem histórico de tensão, adote tom mais delicado
   - Quando a pessoa tem histórico positivo, pode ser mais leve e curioso
   - NUNCA use o histórico para fazer parecer que você está monitorando — seja natural

5. FAMÍLIA: Nunca assuma que a mãe/pai de um filho é o cônjuge atual.

6. MEMÓRIA DISTANTE: Se usar cinzas, diga "lembro vagamente que...".

7. PERGUNTAS ABERTAS: Só quando precisar agir:
   [PERGUNTA_ABERTA: "texto" | contexto]

8. GATILHOS — formato EXATO obrigatório:
   [SALVAR_EVENTO: título | YYYY-MM-DD | alta|media|baixa | true|false | permanent|recurring_annual|deadline|one_time]
   [AGENDAR: título | YYYY-MM-DDTHH:MM:SS-03:00 | minutos]
   [ATUALIZAR_EVENTO: busca | título | YYYY-MM-DDTHH:MM:SS-03:00 | minutos]
   [AGENDAR_GOOGLE: título | YYYY-MM-DDTHH:MM:SS-03:00 | minutos]
   [ATUALIZAR_GOOGLE: busca | título | YYYY-MM-DDTHH:MM:SS-03:00 | minutos]
   [DELETAR_GOOGLE: busca]
   [LER_EMAILS] — busca emails pelas keywords cadastradas
   [LER_EMAILS: *] — busca os emails mais recentes sem filtro
   [LER_EMAILS: filtro] — busca emails por termo específico (ex: "fatura", "Copel")
   [ADICIONAR_KEYWORD_EMAIL: palavra]
   [REMOVER_KEYWORD_EMAIL: palavra]
   [ATUALIZAR_META: título_parcial | progresso_0_a_100 | etapa_opcional]
   [LIMPAR_PENDENTE]
   [IGNORAR_ULTIMO]
   [SALVAR_LUGAR: nome | lat | lng | raio_metros | categoria]
   [REMOVER_LUGAR: nome]
   [ADICIONAR_ITEM_LISTA: item | nome_do_lugar]
   [REMOVER_ITEM_LISTA: item | nome_do_lugar]
   [MARCAR_FEITO: item | nome_do_lugar]
   [VER_LISTA: nome_do_lugar]

   REGRAS DE EMAIL:
   - Se o usuário pedir detalhes de um email já mencionado na conversa →
     use [LER_EMAILS: remetente_ou_assunto] com o termo do email anterior
     NUNCA emita [LER_EMAILS] sem filtro quando o contexto já indica qual email
     Ex: "pode ver o conteúdo?" após email da Copel → [LER_EMAILS: Copel]

   REGRAS DE META:
   - Emita [ATUALIZAR_META] quando usuário disser que avançou numa meta ou concluiu uma etapa
   - progresso é sempre 0-100 | etapa_opcional: nome da etapa concluída, omita se não mencionada
   - Exemplos: [ATUALIZAR_META: academia | 60] / [ATUALIZAR_META: livro | 100 | terminar leitura]

   REGRAS CRÍTICAS DE EVENTO:
   - SEMPRE emita SALVAR_EVENTO quando o usuário informar uma data ou evento recorrente
   - Data YYYY-MM-DD é OBRIGATÓRIA — converta qualquer formato
   - Aniversários e datas recorrentes: is_recurring=true, decay_type=recurring_annual
   - Deadlines e compromissos únicos: is_recurring=false, decay_type=deadline ou one_time
   - PROIBIDO omitir qualquer campo — formato incompleto vaza no texto
   - Os gatilhos ficam INVISÍVEIS — nunca aparecem na resposta ao usuário

9. Ao final: [CLASSE: info] ou [CLASSE: noise]

10. LOCALIZAÇÃO: Use o endereço formatado para contextualizar. Não mencione coordenadas numéricas.
`.trim();

    // ============================================================
    // CONVERSA ESTRUTURADA
    // ============================================================
    const { data: historyForMessages } = await supabase
      .from('brain').select('content, metadata')
      .eq('user_id', stringId).neq('category', 'archived')
      .order('created_at', { ascending: false }).limit(10);

    type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

    const conversationMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...(historyForMessages || []).reverse().flatMap((h: any): ChatMessage[] => [
        { role: 'user',      content: h.content },
        { role: 'assistant', content: (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim() }
      ]),
      { role: 'user', content: messageText }
    ];

    // ============================================================
    // DETECÇÃO ANTECIPADA — "ignore isso"
    // ============================================================
    const ignorePatterns = /ignore isso|ignora isso|não salva|nao salva|apaga isso|esquece isso|esquece|delete isso/i;
    if (ignorePatterns.test(messageText)) {
      const { data: lastEntry } = await supabase
        .from('brain').select('id').eq('user_id', stringId)
        .order('created_at', { ascending: false }).limit(1).single();

      if (lastEntry) await supabase.from('brain').delete().eq('id', lastEntry.id);
      await sendTelegram(chatId, 'Feito — apaguei o que foi dito antes. 🗑️');
      return new Response('OK', { status: 200 });
    }

    // ============================================================
    // PRÉ-EXTRAÇÃO
    // ============================================================
    const noisePatterns = /^(ok|oi|olá|ola|bom dia|boa tarde|boa noite|tudo bem|tudo bom|blz|vlw|valeu|obrigad|kkk|haha|rs|👍|🙏|😂|!)[\s!?.]*$/i;
    const isLikelyNoise = noisePatterns.test(messageText.trim()) && messageText.length < 30;

    let extractionSummary = '';
    if (!isLikelyNoise) {
      try {
        extractionSummary = await extractAndSummarize(stringId, authorName, messageText);
      } catch (e) {
        console.error('[Extrator/pre] Erro:', e);
      }
    }

    const feedbackContent = extractionSummary
      ? `[INTERNO]\nRegistrado: ${extractionSummary}\nConfirme em 1 frase curta. Ex: "Dia 13 de dezembro, certo." / "Guardei o aniversário de casamento."\nPROIBIDO: "Anota aí", "Anotado!", "Registrado!" — nunca.`
      : `[INTERNO]\nVocê é o assistente — NUNCA diga "Anota aí" ou peça ao usuário para anotar algo.\nSe o usuário informar uma data ou fato, confirme brevemente ou responda naturalmente.`;
    conversationMessages.push({ role: 'system', content: feedbackContent });

    // ============================================================
    // SPRINT 1 — #2 chamada com modelo e temperatura roteados
    // ============================================================
    let aiReply = await callOpenRouter(conversationMessages, modelRoute.model, temperature);

    // ============================================================
    // INTERCEPTORES
    // ============================================================
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/gi, '').trim();

    if (!aiReply && extractionSummary) {
      const feedbacks = ['Certo.', 'Ok.', 'Guardei.', 'Entendido.'];
      aiReply = feedbacks[Math.floor(Math.random() * feedbacks.length)];
    }

    const pendingMatch = aiReply.match(/\[?PERGUNTA_ABERTA:\s*[\"']?([^\"'|\]]+)[\"']?\s*\|\s*([^\]]+)\]?/i);
    if (pendingMatch) {
      let ctx = null;
      try { ctx = JSON.parse(pendingMatch[2]); } catch { ctx = { tag: pendingMatch[2].trim() }; }
      await setPendingQuestion(stringId, pendingMatch[1].trim(), ctx);
      aiReply = aiReply.replace(pendingMatch[0], '').trim();
    }

    if (aiReply.includes('[LIMPAR_PENDENTE]')) {
      await clearPendingQuestion(stringId);
      aiReply = aiReply.replace(/\[LIMPAR_PENDENTE\]/gi, '').trim();
    }

    if (aiReply.includes('[IGNORAR_ULTIMO]')) {
      const { data: lastEntry } = await supabase
        .from('brain').select('id').eq('user_id', stringId)
        .order('created_at', { ascending: false }).limit(1).single();
      if (lastEntry) await supabase.from('brain').delete().eq('id', lastEntry.id);
      aiReply = aiReply.replace(/\[IGNORAR_ULTIMO\]/gi, '').trim();
    }

    // Salvar evento
    const eventRegex = /\[SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\s*\|\s*(permanent|recurring_annual|deadline|one_time)\]/gi;
    for (const m of Array.from(aiReply.matchAll(eventRegex)) as any[]) {
      const evTitle = m[1].trim();
      const catMap: Record<string, string> = {
        aniversario: 'family', aniversário: 'family',
        casamento: 'family', pascoa: 'family', páscoa: 'family',
        natal: 'family', 'ano novo': 'family',
        consulta: 'health', médic: 'health', exame: 'health',
        reuniao: 'work', reunião: 'work', entrega: 'work', prazo: 'work',
        viagem: 'personal', ferias: 'personal', férias: 'personal',
      };
      const titleLower    = evTitle.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const eventCategory = Object.entries(catMap).find(([k]) => titleLower.includes(k))?.[1] || 'personal';
      const emotionalWeight = m[3] === 'alta' ? 0.9 : m[3] === 'media' ? 0.6 : 0.3;

      await upsertEvent(stringId, {
        title: evTitle, event_date: m[2], priority: m[3],
        is_recurring: m[4] === 'true', decay_type: m[5],
        category: eventCategory, emotional_weight: emotionalWeight,
      });
      aiReply = aiReply.replace(m[0], '').trim();
    }

    // Outlook Calendar
    const sMatch = aiReply.match(/\[?AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i);
    if (sMatch) {
      const res = await createOutlookEvent(sMatch[1].trim(), sMatch[2].trim(), parseInt(sMatch[3]));
      aiReply = aiReply.replace(sMatch[0], '').trim() + `\n\n🗓️ *Agendado (Outlook):* ${res}`;
    }

    const uMatch = aiReply.match(/\[?ATUALIZAR_EVENTO:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i);
    if (uMatch) {
      const res = await updateOutlookEvent(uMatch[1].trim(), uMatch[2].trim(), uMatch[3].trim(), parseInt(uMatch[4]));
      aiReply = aiReply.replace(uMatch[0], '').trim() + `\n\n🗓️ *Atualizado (Outlook):* ${res}`;
    }

    // Google Calendar
    const gMatch = aiReply.match(/\[?AGENDAR_GOOGLE:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i);
    if (gMatch) {
      const res = await createGoogleEvent(gMatch[1].trim(), gMatch[2].trim(), parseInt(gMatch[3]));
      aiReply = aiReply.replace(gMatch[0], '').trim() + `\n\n🗓️ *Agendado (Google):* ${res}`;
    }

    const guMatch = aiReply.match(/\[?ATUALIZAR_GOOGLE:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i);
    if (guMatch) {
      const res = await updateGoogleEvent(guMatch[1].trim(), guMatch[2].trim(), guMatch[3].trim(), parseInt(guMatch[4]));
      aiReply = aiReply.replace(guMatch[0], '').trim() + `\n\n🗓️ *Atualizado (Google):* ${res}`;
    }

    const gdMatch = aiReply.match(/\[?DELETAR_GOOGLE:\s*(.*?)\]?/i);
    if (gdMatch) {
      const res = await deleteGoogleEvent(gdMatch[1].trim());
      aiReply = aiReply.replace(gdMatch[0], '').trim() + `\n\n🗑️ *Removido (Google):* ${res}`;
    }

    // Emails
    const emailMatch = aiReply.match(/\[LER_EMAILS(?::\s*([^\]]+))?\]/i);
    if (emailMatch) {
      const filtro    = emailMatch[1]?.trim() || undefined;
      const semFiltro = !filtro || filtro === '*' || filtro === 'todos';
      const emails    = semFiltro ? await getRecentEmails(undefined, 10, true) : await getRecentEmails(filtro);
      aiReply = aiReply.replace(emailMatch[0], '').trim();
      aiReply = aiReply ? `${aiReply}\n\n${emails}` : emails;
    }

    const addKwMatch = aiReply.match(/\[ADICIONAR_KEYWORD_EMAIL:\s*([^\]]+)\]/i);
    if (addKwMatch) {
      const resultado = await addEmailKeyword(addKwMatch[1].trim());
      aiReply = aiReply.replace(addKwMatch[0], '').trim();
      aiReply = aiReply ? `${aiReply}\n\n${resultado}` : resultado;
    }

    const removeKwMatch = aiReply.match(/\[REMOVER_KEYWORD_EMAIL:\s*([^\]]+)\]/i);
    if (removeKwMatch) {
      const resultado = await removeEmailKeyword(removeKwMatch[1].trim());
      aiReply = aiReply.replace(removeKwMatch[0], '').trim();
      aiReply = aiReply ? `${aiReply}\n\n${resultado}` : resultado;
    }

    // Atualizar meta
    const goalProgressMatch = aiReply.match(/\[ATUALIZAR_META:\s*([^|]+)\|\s*(\d+)(?:\|\s*([^\]]+))?\]/i);
    if (goalProgressMatch) {
      const resultado = await updateGoalProgress(
        stringId,
        goalProgressMatch[1].trim(),
        parseInt(goalProgressMatch[2]),
        goalProgressMatch[3]?.trim()
      );
      aiReply = aiReply.replace(goalProgressMatch[0], '').trim();
      console.log('[goals]', resultado);
    }

    // ============================================================
    // LISTA DE COMPRAS E LUGARES FAVORITOS
    // ============================================================

    const salvarLugarMatch = aiReply.match(/\[SALVAR_LUGAR:\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*(\d+)\s*\|\s*([^\]]+)\]/i);
    if (salvarLugarMatch) {
      const [, nome, lat, lng, raio, categoria] = salvarLugarMatch;
      const { error: placeErr } = await supabase.from('favorite_places').upsert(
        { user_id: stringId, name: nome.trim(), lat: parseFloat(lat), lng: parseFloat(lng), radius_meters: parseInt(raio), category: categoria.trim() },
        { onConflict: 'user_id,name' }
      );
      if (placeErr) console.error('[Lista] Erro ao salvar lugar:', placeErr.message);
      aiReply = aiReply.replace(salvarLugarMatch[0], '').trim();
    }

    const removerLugarMatch = aiReply.match(/\[REMOVER_LUGAR:\s*([^\]]+)\]/i);
    if (removerLugarMatch) {
      await supabase.from('favorite_places').delete().eq('user_id', stringId).ilike('name', removerLugarMatch[1].trim());
      aiReply = aiReply.replace(removerLugarMatch[0], '').trim();
    }

    async function getPlaceId(userId: string, nomeLugar: string): Promise<string | null> {
      const { data } = await supabase.from('favorite_places').select('id').eq('user_id', userId).ilike('name', nomeLugar.trim()).single();
      return data?.id ?? null;
    }

    const addItemMatch = aiReply.match(/\[ADICIONAR_ITEM_LISTA:\s*([^|]+)\|\s*([^\]]+)\]/i);
    if (addItemMatch) {
      const placeId = await getPlaceId(stringId, addItemMatch[2]);
      if (placeId) {
        await supabase.from('shopping_items').upsert(
          { user_id: stringId, item: addItemMatch[1].trim(), place_id: placeId, done: false },
          { onConflict: 'user_id,item,place_id' }
        );
      }
      aiReply = aiReply.replace(addItemMatch[0], '').trim();
    }

    const marcarFeitoMatch = aiReply.match(/\[MARCAR_FEITO:\s*([^|]+)\|\s*([^\]]+)\]/i);
    if (marcarFeitoMatch) {
      const placeId = await getPlaceId(stringId, marcarFeitoMatch[2]);
      if (placeId) {
        await supabase.from('shopping_items').update({ done: true }).eq('user_id', stringId).ilike('item', marcarFeitoMatch[1].trim()).eq('place_id', placeId);
      }
      aiReply = aiReply.replace(marcarFeitoMatch[0], '').trim();
    }

    const removerItemMatch = aiReply.match(/\[REMOVER_ITEM_LISTA:\s*([^|]+)\|\s*([^\]]+)\]/i);
    if (removerItemMatch) {
      const placeId = await getPlaceId(stringId, removerItemMatch[2]);
      if (placeId) {
        await supabase.from('shopping_items').delete().eq('user_id', stringId).ilike('item', removerItemMatch[1].trim()).eq('place_id', placeId);
      }
      aiReply = aiReply.replace(removerItemMatch[0], '').trim();
    }

    const verListaMatch = aiReply.match(/\[VER_LISTA:\s*([^\]]+)\]/i);
    if (verListaMatch) {
      const placeId = await getPlaceId(stringId, verListaMatch[1]);
      if (placeId) {
        const { data: itensPendentes } = await supabase.from('shopping_items').select('item, done').eq('user_id', stringId).eq('place_id', placeId).order('done');
        if (itensPendentes?.length) {
          const listaTexto = itensPendentes.map(i => `${i.done ? '✅' : '•'} ${i.item}`).join('\n');
          aiReply = aiReply.replace(verListaMatch[0], listaTexto).trim();
        } else {
          aiReply = aiReply.replace(verListaMatch[0], 'Lista vazia.').trim();
        }
      }
    }

    // ============================================================
    // PERSISTÊNCIA
    // ============================================================
    const { error: insertError } = await supabase.from('brain').insert([{
      content:     messageText,
      category,
      user_id:     stringId,
      session_id:  sessionId,
      project_tag: 'geral',
      embedding:   queryEmbedding,
      metadata: {
        ai_reply:         aiReply,
        user:             authorName,
        horizon:          weights.horizon,
        pending_resolved: !!pendingQuestion,
        // Sprint 1 — registra modelo e temperatura usados para debugging/analytics
        model_used:       modelRoute.model,
        model_label:      modelRoute.label,
        temperature_used: temperature,
        contexts_detected: detectedContexts,
      }
    }]);

    if (insertError) console.error('BRAIN INSERT ERRO:', JSON.stringify(insertError));
    else             console.log('BRAIN INSERT OK — user:', stringId, 'session:', sessionId, 'model:', modelRoute.label);

    for (const memId of hdMemoryIds) await reinforceMemory(memId);

    const tasks: Promise<any>[] = [];

    if (onboardingState?.status === 'in_progress') {
      tasks.push(
        processOnboardingFromMessage(stringId, messageText, aiReply, onboardingState)
          .catch(e => console.error('[Onboarding] Erro:', e))
      );
    }

    if (!isLikelyNoise) {
      tasks.push(
        extractRecomendacao(stringId, messageText, aiReply)
          .catch(e => console.error('[Extrator/recomendacao] Erro:', e))
      );
      tasks.push(
        extractDiary(stringId, messageText, 'anytime')
          .catch(e => console.error('[diary] Erro:', e))
      );
      tasks.push(
        extractGoal(stringId, messageText)
          .catch(e => console.error('[goals] Erro:', e))
      );
    }

    // SPRINT 1 — sendTelegram desacoplado dos extratores
    // Resposta vai pro usuário imediatamente; extratores e compactação rodam em background.
    await sendTelegram(chatId, aiReply);

    // Background: não bloqueia a resposta
    Promise.all([
      ...tasks,
      supabase
        .from('brain').select('*', { count: 'exact', head: true })
        .eq('user_id', stringId).eq('category', 'info')
        .then(({ count }) => {
          if (count && count >= 20) return compactMemory(stringId, authorName);
        }),
    ]).catch(e => console.error('[Background] Erro:', e));

    return NextResponse.json({ ok: true });

  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true });
  }
}