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
import { createGoogleEvent, updateGoogleEvent } from '@/lib/google';
import {
  classifyTemporalHorizon,
  buildWeightedContext,
  truncateByWeight
} from '@/lib/context-router';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const message = body.message;
    let messageText = message?.text || "";

    // ============================================================
    // 🎤 MOTOR DE AUDIÇÃO (WHISPER) — CORRIGIDO
    // Problema anterior: falha silenciosa deixava messageText vazio
    // ============================================================
    if (message?.voice) {
      try {
        const fileId = message.voice.file_id;

        const getFile = await fetch(
          `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
        );
        const fileData = await getFile.json();

        if (!fileData.ok) {
          console.error("Telegram getFile falhou:", fileData);
          await sendTelegram(message.chat.id, "⚠️ Não consegui acessar o áudio. Tenta de novo?");
          return NextResponse.json({ ok: true });
        }

        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileData.result.file_path}`;
        const audioRes = await fetch(fileUrl);

        if (!audioRes.ok) {
          console.error("Download do áudio falhou:", audioRes.status);
          await sendTelegram(message.chat.id, "⚠️ Falha ao baixar o áudio. Tenta de novo?");
          return NextResponse.json({ ok: true });
        }

        const buffer = await audioRes.arrayBuffer();

        // Tenta transcrever com múltiplos formatos — Telegram manda .oga
        // que alguns runtimes não reconhecem como audio/ogg
        const audioFormats = [
          { type: 'audio/mpeg',  ext: 'voice.mp3'  },
          { type: 'audio/ogg',   ext: 'voice.ogg'  },
          { type: 'audio/wav',   ext: 'voice.wav'  },
        ];

        let transcriptionRes: Response | null = null;
        for (const fmt of audioFormats) {
          const formData = new FormData();
          formData.append('file', new Blob([buffer], { type: fmt.type }), fmt.ext);
          formData.append('model', 'whisper-1');
          formData.append('language', 'pt'); // força português — melhora precisão

          const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
            body: formData
          });

          if (res.ok) {
            transcriptionRes = res;
            break; // achou um formato que funcionou
          }
          console.warn(`Whisper rejeitou formato ${fmt.type}:`, res.status);
        }

        if (!transcriptionRes) {
          console.error("Whisper falhou em todos os formatos.");
          await sendTelegram(message.chat.id, "⚠️ Não consegui transcrever o áudio. Pode digitar?");
          return NextResponse.json({ ok: true });
        }

        const transcriptionData = await transcriptionRes.json();
        messageText = transcriptionData.text?.trim() || "";

        // CORRIGIDO: se transcrição vazia, avisa em vez de sumir
        if (!messageText) {
          await sendTelegram(message.chat.id, "⚠️ O áudio veio vazio ou não entendi. Pode repetir?");
          return NextResponse.json({ ok: true });
        }

        // Confirma que ouviu (opcional — remove se preferir silencioso)
        // await sendTelegram(message.chat.id, `🎤 _"${messageText}"_`);

      } catch (err) {
        console.error("Erro no pipeline de áudio:", err);
        await sendTelegram(message.chat.id, "⚠️ Erro ao processar áudio. Tenta digitar por enquanto.");
        return NextResponse.json({ ok: true });
      }
    }

    const chatId = message?.chat?.id;
    const telegramUserId = message?.from?.id;
    const userFirstName = message?.from?.first_name || "Usuário";

    if (!messageText || chatId == null || telegramUserId == null) {
      return NextResponse.json({ ok: true });
    }

    const stringId = String(telegramUserId);

    // ============================================================
    // BUSCA DE DADOS EM PARALELO
    // ============================================================
    const [userProfileResult, sessionId, eventsResult, ashesResult] = await Promise.all([
      supabase
        .from('users')
        .select('nickname, current_context, pending_question, pending_context')
        .eq('id', stringId)
        .single(),

      getOrCreateSession(stringId),

      supabase
        .from('events')
        .select('title, event_date, category, decay_type, relevance_score, emotional_weight, is_recurring, notes')
        .eq('user_id', stringId)
        .order('relevance_score', { ascending: false }),

      supabase
        .from('memory_ashes')
        .select('ash_summary, period_start, period_end')
        .eq('user_id', stringId)
        .order('period_end', { ascending: false })
        .limit(5)
    ]);

    const userProfile = userProfileResult.data;
    const authorName = userProfile?.nickname || userFirstName;
    const currentContextL3 = userProfile?.current_context || "Sem dossiê ainda.";
    const pendingQuestion = userProfile?.pending_question || null;
    const pendingContext = userProfile?.pending_context || null;

    // ============================================================
    // MONTA BLOCOS DE CONTEXTO BRUTOS
    // ============================================================

    // Events
    const events = eventsResult.data || [];
    const urgentEvents = events.filter(e => (e.relevance_score || 0) >= 0.7);
    const radarEvents  = events.filter(e => (e.relevance_score || 0) >= 0.3 && (e.relevance_score || 0) < 0.7);
    const eventsBlock  = events.length > 0 ? [
      urgentEvents.length > 0
        ? `🔴 PRÓXIMOS/URGENTES:\n${urgentEvents.map(e =>
            `  - ${e.title}: ${e.event_date}${e.notes ? ` (${e.notes})` : ''}`
          ).join('\n')}`
        : null,
      radarEvents.length > 0
        ? `🟡 NO RADAR:\n${radarEvents.map(e =>
            `  - ${e.title}: ${e.event_date}`
          ).join('\n')}`
        : null,
    ].filter(Boolean).join('\n\n') : "Nenhum evento cadastrado.";

    // Cinzas
    const ashes = ashesResult.data || [];
    const ashesBlock = ashes.length > 0
      ? ashes.map(a => a.ash_summary).join('\n')
      : null;

    // HD vetorial
    const queryEmbedding = await generateEmbedding(messageText);
    let hdBlock = "";
    let hdMemoryIds: string[] = [];

    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', {
        query_embedding: queryEmbedding,
        match_threshold: 0.4,
        match_count: 3
      }) as { data: any[] | null };

      if (search && search.length > 0) {
        hdBlock = search
          .filter(r => !r.summary.startsWith('[CINZA]'))
          .map(r => r.summary)
          .join('\n---\n');
        hdMemoryIds = search.map(r => r.id);
      }
    }

    // RAM — histórico da sessão atual
    const { data: historySession } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('user_id', stringId)
      .eq('session_id', sessionId)
      .neq('category', 'noise')
      .order('created_at', { ascending: false })
      .limit(8);

    // Fallback: histórico geral recente se sessão vazia
    const { data: historyGeral } = (!historySession?.length)
      ? await supabase
          .from('brain')
          .select('content, metadata')
          .eq('user_id', stringId)
          .neq('category', 'noise')
          .order('created_at', { ascending: false })
          .limit(8)
      : { data: null };

    const historyFinal = historySession?.length ? historySession : (historyGeral || []);
    const ramBlock = historyFinal.reverse().map((h: any) => {
      const ai = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
      return `${authorName}: ${h.content}\nJarvis: ${ai}`;
    }).join('\n\n');

    // ============================================================
    // 🧭 CLASSIFICADOR TEMPORAL — coração do roteamento
    // ============================================================
    const weights = classifyTemporalHorizon(messageText, ramBlock, pendingQuestion);
    console.log(`[ContextRouter] Horizonte: ${weights.horizon} | ${weights.reason}`);

    // Trunca cada bloco pelo peso relativo (total: ~6000 chars)
    const truncatedRam    = truncateByWeight(ramBlock, weights.ram, 6000);
    const truncatedL3     = truncateByWeight(currentContextL3, weights.l3, 6000);
    const truncatedHd     = truncateByWeight(hdBlock, weights.hd, 6000);
    const truncatedAshes  = ashes.length > 0 ? truncateByWeight(ashesBlock || '', weights.ashes, 6000) : null;
    const truncatedEvents = truncateByWeight(eventsBlock, weights.events, 6000);

    // Monta o contexto ponderado
    const weightedContext = buildWeightedContext(weights, {
      ram: truncatedRam,
      l3: truncatedL3,
      hd: truncatedHd,
      ashes: truncatedAshes,
      events: truncatedEvents,
      authorName,
      pendingQuestion,
      pendingContext
    });

    // ============================================================
    // PROMPT FINAL v1.3 — limpo e hierárquico
    // ============================================================
    const fusoLondrina = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const finalPrompt = `
JARVIS | USUÁRIO: ${authorName} | ${fusoLondrina} | MODO: ${weights.horizon.toUpperCase()}

${weightedContext}

═══════════════════════════════════════
MENSAGEM: "${messageText}"
═══════════════════════════════════════

REGRAS:
1. FOCO: Responda O QUE FOI PERGUNTADO. Não mude de assunto na mesma resposta.
2. PERSONALIDADE: Tony Stark — direto, inteligente, sem enrolação.
3. MEMÓRIA DISTANTE: Se usar cinzas, diga "lembro vagamente que...".
4. UMA pergunta por resposta. Se fizer pergunta: [PERGUNTA_ABERTA: "texto" | contexto]
5. GATILHOS:
   - [SALVAR_EVENTO: título | YYYY-MM-DD | alta|media|baixa | true|false | permanent|recurring_annual|deadline|one_time]
   - [AGENDAR: título | YYYY-MM-DDTHH:MM | minutos]
   - [ATUALIZAR_EVENTO: busca | título | YYYY-MM-DDTHH:MM | minutos]
   - [LIMPAR_PENDENTE]
6. Ao final: [CLASSE: info] ou [CLASSE: noise]
`;

    let aiReply = await callOpenRouter(finalPrompt);

    // ============================================================
    // INTERCEPTORES
    // ============================================================
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/gi, '').trim();

    const pendingMatch = aiReply.match(/\[PERGUNTA_ABERTA:\s*"([^"]+)"\s*\|\s*(\{.*?\}|\w+)\]/i);
    if (pendingMatch) {
      let ctx = null;
      try { ctx = JSON.parse(pendingMatch[2]); } catch { ctx = { tag: pendingMatch[2] }; }
      await setPendingQuestion(stringId, pendingMatch[1], ctx);
      aiReply = aiReply.replace(pendingMatch[0], '').trim();
    }

    if (aiReply.includes('[LIMPAR_PENDENTE]')) {
      await clearPendingQuestion(stringId);
      aiReply = aiReply.replace(/\[LIMPAR_PENDENTE\]/gi, '').trim();
    }

    // Salvar evento
    const eventRegex = /\[?SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\s*\|\s*(permanent|recurring_annual|deadline|one_time)\]?/gi;
    for (const m of Array.from(aiReply.matchAll(eventRegex)) as any[]) {
      await supabase.from('events').insert([{
        user_id: stringId,
        title: m[1].trim(),
        event_date: m[2],
        priority: m[3].toLowerCase(),
        is_recurring: m[4] === 'true',
        decay_type: m[5],
        last_notified_year: new Date().getFullYear() - 1
      }]);
      aiReply = aiReply.replace(m[0], '').trim();
    }

    // Agendar Google
    const sMatch = aiReply.match(/\[?AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i);
    if (sMatch) {
      const res = await createGoogleEvent(sMatch[1].trim(), sMatch[2].trim(), parseInt(sMatch[3]));
      aiReply = aiReply.replace(sMatch[0], '').trim() + `\n\n🗓️ *Agendado:* ${res}`;
    }

    // Atualizar Google
    const uMatch = aiReply.match(/\[?ATUALIZAR_EVENTO:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i);
    if (uMatch) {
      const res = await updateGoogleEvent(uMatch[1].trim(), uMatch[2].trim(), uMatch[3].trim(), parseInt(uMatch[4]));
      aiReply = aiReply.replace(uMatch[0], '').trim() + `\n\n🗓️ *Atualizado:* ${res}`;
    }

    // ============================================================
    // PERSISTÊNCIA
    // ============================================================
    await supabase.from('brain').insert([{
      content: messageText,
      category,
      user_id: stringId,
      session_id: sessionId,
      project_tag: 'geral',
      embedding: queryEmbedding,
      metadata: {
        ai_reply: aiReply,
        user: authorName,
        horizon: weights.horizon,
        pending_resolved: !!pendingQuestion
      }
    }]);

    for (const memId of hdMemoryIds) await reinforceMemory(memId);

    await sendTelegram(chatId, aiReply);

    // Compactação
    const { count } = await supabase
      .from('brain')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', stringId)
      .eq('category', 'info');

    if (count && count >= 5) await compactMemory(stringId, authorName);

    return NextResponse.json({ ok: true });

  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true });
  }
                                                    }
