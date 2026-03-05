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

    // ============================================================
    // CAMADA L3 — DOSSIÊ DO USUÁRIO
    // ============================================================
    const { data: userProfile } = await supabase
      .from('users')
      .select('nickname, current_context, pending_question, pending_context')
      .eq('id', stringId)
      .single();

    const authorName = userProfile?.nickname || userFirstName;
    const currentContextL3 = userProfile?.current_context || "Sem dossiê ainda.";
    const pendingQuestion = userProfile?.pending_question || null;
    const pendingContext = userProfile?.pending_context || null;

    // ============================================================
    // CAMADA L3 — SESSÃO ATUAL
    // Garante que o contexto da conversa não se perde entre turnos
    // ============================================================
    const sessionId = await getOrCreateSession(stringId);

    // ============================================================
    // CAMADA HD — BUSCA VETORIAL (Memórias de Longo Prazo)
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
        hdContext = search.map(r => `[Memória]: ${r.summary}`).join('\n');
        hdMemoryIds = search.map(r => r.id);
      }
    }

    // ============================================================
    // CAMADA RAM — HISTÓRICO RECENTE (CORRIGIDO: filtra por user_id)
    // ============================================================
    const { data: history } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('user_id', stringId)       // ← CORRIGIDO: coluna user_id agora existe
      .eq('session_id', sessionId)   // ← NOVO: histórico da sessão atual primeiro
      .neq('category', 'noise')
      .order('created_at', { ascending: false })
      .limit(10);

    // Se não houver histórico da sessão, busca geral recente
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
    // CONSTRUÇÃO DO PROMPT FINAL
    // Inclui: Dossiê L3 + Sessão + RAM + HD + Pergunta Pendente
    // ============================================================
    const pendingBlock = pendingQuestion
      ? `\n[⚠️ PERGUNTA PENDENTE SEM RESPOSTA]: "${pendingQuestion}"
[CONTEXTO DA PERGUNTA]: ${JSON.stringify(pendingContext)}
INSTRUÇÃO: Se a mensagem atual for uma confirmação ("sim", "pode", "quero", "não", "negativo"), resolva a pergunta pendente antes de qualquer outra coisa. Após resolver, limpe o estado com [LIMPAR_PENDENTE].`
      : "";

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
${pendingBlock}
═══════════════════════════════════════
MENSAGEM ATUAL: "${messageText}"
═══════════════════════════════════════

MISSÃO E REGRAS:
1. PERSONALIDADE: Tony Stark. Direto, inteligente, levemente sarcástico quando apropriado.
   Sem saudações genéricas. Sem repetir o nome toda frase.
   
2. MEMÓRIA OBRIGATÓRIA: Use o HISTÓRICO RAM e DOSSIÊ para manter continuidade.
   Nunca faça perguntas que já foram respondidas acima.
   
3. PERGUNTAS ABERTAS: Se você fizer UMA pergunta ao usuário, registre com:
   [PERGUNTA_ABERTA: "texto exato da pergunta" | contexto_json]
   Só UMA pergunta por resposta. Nunca duas.

4. GATILHOS DE AÇÃO (use quando necessário):
   - Salvar evento recorrente: [SALVAR_EVENTO: título | YYYY-MM-DD | alta|media|baixa | true|false]
   - Agendar no Google Calendar: [AGENDAR: título | YYYY-MM-DDTHH:MM | minutos_lembrete]
   - Atualizar evento existente: [ATUALIZAR_EVENTO: termo_busca | novo_título | YYYY-MM-DDTHH:MM | minutos]
   - Limpar pergunta pendente: [LIMPAR_PENDENTE]
   
5. CLASSIFICAÇÃO OBRIGATÓRIA ao final: [CLASSE: info] ou [CLASSE: noise]
   - info: qualquer coisa com dado, decisão, evento, preferência
   - noise: apenas "ok", "entendido", "vlw" sem conteúdo

6. Ajuste de comportamento como "diminuir humor X%" deve ser respeitado e persistido.
`;

    let aiReply = await callOpenRouter(finalPrompt);

    // ============================================================
    // INTERCEPTOR 1 — CLASSIFICAÇÃO
    // ============================================================
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/gi, '').trim();

    // ============================================================
    // INTERCEPTOR 2 — PERGUNTA PENDENTE
    // Grava se o Jarvis fez uma pergunta que precisa de resposta
    // ============================================================
    const pendingMatch = aiReply.match(/\[PERGUNTA_ABERTA:\s*"([^"]+)"\s*\|\s*(\{.*?\}|\w+)\]/i);
    if (pendingMatch) {
      let ctx = null;
      try { ctx = JSON.parse(pendingMatch[2]); } catch { ctx = { tag: pendingMatch[2] }; }
      await setPendingQuestion(stringId, pendingMatch[1], ctx);
      aiReply = aiReply.replace(pendingMatch[0], '').trim();
    }

    // ============================================================
    // INTERCEPTOR 3 — LIMPAR PERGUNTA PENDENTE
    // ============================================================
    if (aiReply.includes('[LIMPAR_PENDENTE]')) {
      await clearPendingQuestion(stringId);
      aiReply = aiReply.replace(/\[LIMPAR_PENDENTE\]/gi, '').trim();
    }

    // ============================================================
    // INTERCEPTOR 4 — SALVAR EVENTO
    // ============================================================
    const eventRegex = /\[?SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\]?/gi;
    const evMatches = Array.from(aiReply.matchAll(eventRegex)) as any[];
    for (const m of evMatches) {
      if (m && m.length >= 5) {
        await supabase.from('events').insert([{
          user_id: stringId,
          title: m[1].trim(),
          event_date: m[2],
          priority: m[3].toLowerCase(),
          is_recurring: m[4].toLowerCase() === 'true',
          last_notified_year: new Date().getFullYear() - 1
        }]);
        aiReply = aiReply.replace(m[0], '').trim();
      }
    }

    // ============================================================
    // INTERCEPTOR 5 — AGENDAR NO GOOGLE CALENDAR
    // ============================================================
    const scheduleRegex = /\[?AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i;
    const sMatch = aiReply.match(scheduleRegex);
    if (sMatch && sMatch.length >= 4) {
      const res = await createGoogleEvent(sMatch[1].trim(), sMatch[2].trim(), parseInt(sMatch[3]));
      aiReply = aiReply.replace(sMatch[0], '').trim() + `\n\n🗓️ *Agendado:* ${res}`;
    }

    // ============================================================
    // INTERCEPTOR 6 — ATUALIZAR EVENTO NO GOOGLE CALENDAR
    // ============================================================
    const updateRegex = /\[?ATUALIZAR_EVENTO:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i;
    const uMatch = aiReply.match(updateRegex);
    if (uMatch && uMatch.length >= 5) {
      const res = await updateGoogleEvent(uMatch[1].trim(), uMatch[2].trim(), uMatch[3].trim(), parseInt(uMatch[4]));
      aiReply = aiReply.replace(uMatch[0], '').trim() + `\n\n🗓️ *Atualizado:* ${res}`;
    }

    // ============================================================
    // PERSISTÊNCIA NA RAM
    // CORRIGIDO: inclui user_id e session_id
    // ============================================================
    await supabase.from('brain').insert([{
      content: messageText,
      category,
      user_id: stringId,           // ← CORRIGIDO
      session_id: sessionId,       // ← NOVO: vincula à sessão
      project_tag: 'geral',        // ← CORRIGIDO: não deixa NULL
      embedding: queryEmbedding,
      metadata: {
        ai_reply: aiReply,
        user: authorName,
        pending_resolved: pendingQuestion ? true : false
      }
    }]);

    // Reforça memórias HD que foram usadas
    for (const memId of hdMemoryIds) {
      await reinforceMemory(memId);
    }

    // ============================================================
    // ENVIO
    // ============================================================
    await sendTelegram(chatId, aiReply);

    // ============================================================
    // COMPACTAÇÃO — CORRIGIDO: threshold 5 (era 20)
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
