import { NextResponse } from 'next/server';
import {
  supabase,
  callOpenRouter,
  generateEmbedding,
  sendTelegram,
  compactMemory,
  getOrCreateSession,
  getPendingQuestion,
  setPendingQuestion,
  clearPendingQuestion,
  reinforceMemory
} from '@/lib/jarvis';
import { createGoogleEvent, updateGoogleEvent } from '@/lib/google';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const message = body.message;
    let messageText = message?.text || "";

    // ============================================================
    // 🎤 MOTOR DE AUDIÇÃO (WHISPER)
    // ============================================================
    if (message?.voice) {
      try {
        const fileId = message.voice.file_id;
        const getFile = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
        const fileData = await getFile.json();

        if (fileData.ok) {
          const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileData.result.file_path}`;
          const audioRes = await fetch(fileUrl);
          const buffer = await audioRes.arrayBuffer();

          const formData = new FormData();
          formData.append('file', new Blob([buffer], { type: 'audio/ogg' }), 'voice.ogg');
          formData.append('model', 'whisper-1');

          const transcriptionRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
            body: formData
          });

          const transcriptionData = await transcriptionRes.json();
          messageText = transcriptionData.text || "";
        }
      } catch (err) {
        console.error("Falha no áudio:", err);
      }
    }

    const chatId = message?.chat?.id;
    const telegramUserId = message?.from?.id;
    const userFirstName = message?.from?.first_name || "Usuário";

    if (!messageText || chatId == null || telegramUserId == null) {
      return NextResponse.json({ ok: true });
    }

    const stringId = String(telegramUserId);
    const hoje = new Date();

    // ============================================================
    // BUSCA DE DADOS EM PARALELO (mais rápido)
    // ============================================================
    const [
      userProfileResult,
      sessionId,
      eventsResult,
      ashesResult
    ] = await Promise.all([
      // Perfil + dossiê L3
      supabase
        .from('users')
        .select('nickname, current_context, pending_question, pending_context')
        .eq('id', stringId)
        .single(),

      // Sessão ativa
      getOrCreateSession(stringId),

      // NOVO: Todos os eventos do usuário com relevância calculada
      supabase
        .from('events')
        .select('title, event_date, category, decay_type, relevance_score, emotional_weight, is_recurring, notes')
        .eq('user_id', stringId)
        .order('relevance_score', { ascending: false }),

      // NOVO: Cinzas (memórias arquivadas — contexto vago de longo prazo)
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
    // PROCESSA EVENTOS — separa por relevância e urgência
    // ============================================================
    const events = eventsResult.data || [];
    const now = hoje;

    // Eventos urgentes: nos próximos 7 dias (relevância alta)
    const urgentEvents = events.filter(e => {
      const score = e.relevance_score || 0;
      return score >= 0.7;
    });

    // Eventos no radar: relevância média
    const radarEvents = events.filter(e => {
      const score = e.relevance_score || 0;
      return score >= 0.3 && score < 0.7;
    });

    // Monta bloco de eventos para o prompt
    const eventsContext = events.length > 0
      ? [
          urgentEvents.length > 0
            ? `🔴 URGENTE/PRÓXIMOS:\n${urgentEvents.map(e =>
                `  - ${e.title}: ${e.event_date} [${e.decay_type}] relevância: ${(e.relevance_score || 0).toFixed(2)}${e.notes ? ` — ${e.notes}` : ''}`
              ).join('\n')}`
            : null,
          radarEvents.length > 0
            ? `🟡 NO RADAR:\n${radarEvents.map(e =>
                `  - ${e.title}: ${e.event_date} [${e.decay_type}]${e.notes ? ` — ${e.notes}` : ''}`
              ).join('\n')}`
            : null,
        ].filter(Boolean).join('\n\n') || "Nenhum evento relevante no momento."
      : "Nenhum evento cadastrado ainda.";

    // ============================================================
    // PROCESSA CINZAS — contexto vago de memórias antigas
    // ============================================================
    const ashes = ashesResult.data || [];
    const ashesContext = ashes.length > 0
      ? ashes.map(a => a.ash_summary).join('\n')
      : null;

    // ============================================================
    // CAMADA HD — BUSCA VETORIAL
    // ============================================================
    const queryEmbedding = await generateEmbedding(messageText);
    let hdContext = "";
    let hdMemoryIds: string[] = [];

    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', {
        query_embedding: queryEmbedding,
        match_threshold: 0.4,
        match_count: 2
      }) as { data: any[] | null };

      if (search && search.length > 0) {
        hdContext = search
          .filter(r => !r.summary.startsWith('[CINZA]')) // ignora cinzas no HD
          .map(r => `[Memória]: ${r.summary}`)
          .join('\n');
        hdMemoryIds = search.map(r => r.id);
      }
    }

    // ============================================================
    // CAMADA RAM — HISTÓRICO RECENTE
    // ============================================================
    const { data: history } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('user_id', stringId)
      .eq('session_id', sessionId)
      .neq('category', 'noise')
      .order('created_at', { ascending: false })
      .limit(10);

    const { data: historyGeral } = (!history || history.length === 0)
      ? await supabase
          .from('brain')
          .select('content, metadata')
          .eq('user_id', stringId)
          .neq('category', 'noise')
          .order('created_at', { ascending: false })
          .limit(10)
      : { data: null };

    const historyFinal = history?.length ? history : (historyGeral || []);

    const ramMemory = historyFinal.reverse().map((h: any) => {
      const ai = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
      return `${authorName}: ${h.content}\nJarvis: ${ai}`;
    }).join('\n');

    // ============================================================
    // CACHE — TIMESTAMP
    // ============================================================
    const fusoLondrina = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    // ============================================================
    // BLOCO DE PERGUNTA PENDENTE
    // ============================================================
    const pendingBlock = pendingQuestion
      ? `\n[⚠️ PERGUNTA PENDENTE SEM RESPOSTA]: "${pendingQuestion}"
[CONTEXTO]: ${JSON.stringify(pendingContext)}
INSTRUÇÃO: Se a mensagem atual for confirmação ("sim", "pode", "quero", "não"), resolva PRIMEIRO antes de qualquer outra coisa. Após resolver, use [LIMPAR_PENDENTE].`
      : "";

    // ============================================================
    // PROMPT FINAL v1.2
    // ============================================================
    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | AGORA: ${fusoLondrina}

═══════════════════════════════════════
[DOSSIÊ L3 — QUEM É ${authorName.toUpperCase()}]
${currentContextL3}
═══════════════════════════════════════

[HISTÓRICO RAM — CONVERSA RECENTE]
${ramMemory || "Início de conversa."}

[MEMÓRIAS HD — LONGO PRAZO]
${hdContext || "Nenhuma memória relevante encontrada."}

[EVENTOS E DATAS IMPORTANTES]
${eventsContext}
${ashesContext ? `\n[MEMÓRIAS DISTANTES — contexto vago]\n${ashesContext}` : ''}
${pendingBlock}
═══════════════════════════════════════
MENSAGEM ATUAL: "${messageText}"
═══════════════════════════════════════

MISSÃO E REGRAS:
1. PERSONALIDADE: Tony Stark. Direto, inteligente, levemente sarcástico.
   Sem saudações genéricas. Sem repetir o nome toda frase.

2. MEMÓRIA: Use TUDO acima para manter continuidade. Nunca pergunte algo já respondido.

3. EVENTOS: Você CONHECE todos os eventos listados acima. Responda sobre datas, 
   aniversários e compromissos SEM pedir que o usuário informe novamente.
   Para eventos urgentes (🔴), seja proativo e sugira ações.

4. CINZAS: Se usar uma memória distante, diga "lembro vagamente que..." para ser honesto
   sobre a imprecisão.

5. PERGUNTAS ABERTAS: Se fizer UMA pergunta, registre com:
   [PERGUNTA_ABERTA: "texto exato" | contexto_json]
   Só UMA por resposta.

6. GATILHOS DE AÇÃO:
   - Salvar evento: [SALVAR_EVENTO: título | YYYY-MM-DD | alta|media|baixa | true|false | permanent|recurring_annual|deadline|one_time]
   - Agendar Google: [AGENDAR: título | YYYY-MM-DDTHH:MM | minutos_lembrete]
   - Atualizar evento Google: [ATUALIZAR_EVENTO: busca | novo_título | YYYY-MM-DDTHH:MM | minutos]
   - Limpar pendente: [LIMPAR_PENDENTE]

7. CLASSIFICAÇÃO ao final: [CLASSE: info] ou [CLASSE: noise]
`;

    let aiReply = await callOpenRouter(finalPrompt);

    // ============================================================
    // INTERCEPTORES
    // ============================================================

    // Classificação
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/gi, '').trim();

    // Pergunta pendente
    const pendingMatch = aiReply.match(/\[PERGUNTA_ABERTA:\s*"([^"]+)"\s*\|\s*(\{.*?\}|\w+)\]/i);
    if (pendingMatch) {
      let ctx = null;
      try { ctx = JSON.parse(pendingMatch[2]); } catch { ctx = { tag: pendingMatch[2] }; }
      await setPendingQuestion(stringId, pendingMatch[1], ctx);
      aiReply = aiReply.replace(pendingMatch[0], '').trim();
    }

    // Limpar pendente
    if (aiReply.includes('[LIMPAR_PENDENTE]')) {
      await clearPendingQuestion(stringId);
      aiReply = aiReply.replace(/\[LIMPAR_PENDENTE\]/gi, '').trim();
    }

    // Salvar evento — ATUALIZADO: agora aceita decay_type
    const eventRegex = /\[?SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\s*\|\s*(permanent|recurring_annual|deadline|one_time)\]?/gi;
    const evMatches = Array.from(aiReply.matchAll(eventRegex)) as any[];
    for (const m of evMatches) {
      if (m && m.length >= 6) {
        await supabase.from('events').insert([{
          user_id: stringId,
          title: m[1].trim(),
          event_date: m[2],
          priority: m[3].toLowerCase(),
          is_recurring: m[4].toLowerCase() === 'true',
          decay_type: m[5],
          last_notified_year: new Date().getFullYear() - 1
        }]);
        aiReply = aiReply.replace(m[0], '').trim();
      }
    }

    // Agendar no Google Calendar
    const scheduleRegex = /\[?AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i;
    const sMatch = aiReply.match(scheduleRegex);
    if (sMatch && sMatch.length >= 4) {
      const res = await createGoogleEvent(sMatch[1].trim(), sMatch[2].trim(), parseInt(sMatch[3]));
      aiReply = aiReply.replace(sMatch[0], '').trim() + `\n\n🗓️ *Agendado:* ${res}`;
    }

    // Atualizar evento no Google Calendar
    const updateRegex = /\[?ATUALIZAR_EVENTO:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i;
    const uMatch = aiReply.match(updateRegex);
    if (uMatch && uMatch.length >= 5) {
      const res = await updateGoogleEvent(uMatch[1].trim(), uMatch[2].trim(), uMatch[3].trim(), parseInt(uMatch[4]));
      aiReply = aiReply.replace(uMatch[0], '').trim() + `\n\n🗓️ *Atualizado:* ${res}`;
    }

    // ============================================================
    // PERSISTÊNCIA NA RAM
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
        pending_resolved: pendingQuestion ? true : false
      }
    }]);

    // Reforça memórias HD usadas
    for (const memId of hdMemoryIds) {
      await reinforceMemory(memId);
    }

    // ============================================================
    // ENVIO
    // ============================================================
    await sendTelegram(chatId, aiReply);

    // ============================================================
    // COMPACTAÇÃO (threshold: 5 mensagens)
    // ============================================================
    const { count } = await supabase
      .from('brain')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', stringId)
      .eq('category', 'info');

    if (count && count >= 5) {
      await compactMemory(stringId, authorName);
    }

    return NextResponse.json({ ok: true });

  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true });
  }
      }
