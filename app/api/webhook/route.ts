import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, generateEmbedding, sendTelegram, compactMemory } from '@/lib/jarvis';
import { createGoogleEvent, updateGoogleEvent } from '@/lib/google';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const message = body.message;
    let messageText = message?.text || "";
    
    // --- 🎤 INTERCEPTOR DE ÁUDIO (HEARING UPGRADE) ---
    if (message?.voice) {
      const fileId = message.voice.file_id;
      const getFile = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
      const fileData = await getFile.json();
      if (fileData.ok) {
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileData.result.file_path}`;
        const audioRes = await fetch(fileUrl);
        const blob = await audioRes.blob();
        
        const formData = new FormData();
        formData.append('file', blob, 'audio.ogg');
        formData.append('model', 'whisper-1');

        const transcriptionRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
          body: formData
        });
        const transcriptionData = await transcriptionRes.json();
        messageText = transcriptionData.text || "";
      }
    }

    const chatId = message?.chat?.id;
    const telegramUserId = message?.from?.id;
    const userFirstName = message?.from?.first_name || "Usuário";

    if (!messageText || chatId == null || telegramUserId == null) return NextResponse.json({ ok: true });

    const stringId = String(telegramUserId);

    // 1. CAMADA L3, 2. CAMADA HD, 3. CAMADA RAM (Mantidos conforme lógica anterior)
    const { data: userProfile } = await supabase.from('users').select('nickname, current_context').eq('id', stringId).single();
    const authorName = userProfile?.nickname || userFirstName;
    const currentContextL3 = userProfile?.current_context || "ERRO_ID_NAO_LOCALIZADO";

    const queryEmbedding = await generateEmbedding(messageText);
    let hdContext = "";
    if (queryEmbedding) {
      const { data: search }: { data: any[] | null } = await supabase.rpc('match_memories', { query_embedding: queryEmbedding, match_threshold: 0.4, match_count: 2 });
      if (search && search.length > 0) hdContext = search.map((r) => `[Memória Antiga]: ${r.summary}`).join('\n');
    }

    const { data: history } = await supabase.from('brain').select('content, category, metadata').eq('user_id', stringId).neq('category', 'noise').order('created_at', { ascending: false }).limit(15); 
    const ramMemory = (history || []).reverse().map((h: any) => `${authorName}: ${h.content}\nJarvis: ${(h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim()}`).join('\n') || "Iniciando diálogo.";

    // 4. CAMADA CACHE & PROMPT (COM AJUSTE DE CONTEXTO)
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const horaAtual = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getHours();

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | HORA: ${horaAtual}h

[DADOS DE PERFIL]
${currentContextL3}

[MEMÓRIA RAM/HD]
${ramMemory}
${hdContext}

MENSAGEM: "${messageText}"

MISSÃO (RIGOR TÉCNICO):
1. SAUDAÇÃO: Use a hora real (${horaAtual}h).
2. GATILHOS PRECISOS:
   - [SALVAR_EVENTO]: APENAS para aniversários ou datas anuais recorrentes.
   - [DESATIVAR_ROTINA]: APENAS se o usuário mencionar explicitamente feriado, folga ou "não me acorde". NÃO use para sugestões de relaxamento.
   - [AGENDAR]: Use para tarefas pontuais (ex: comprar bombons).
3. SIGILO: NUNCA exiba os comandos em colchetes na resposta final.
4. PERSONALIDADE: Estilo Stark. Elegante e conciso.
5. CLASSIFICAÇÃO: Termine com [CLASSE: info] ou [CLASSE: noise].
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    // 5. PROCESSAMENTO E INTERCEPTORES (Tipagem blindada para o Build)
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // INTERCEPTOR: EVENTOS (Loop)
    const eventRegex = /\[?SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\]?/gi;
    const evMatches = Array.from(aiReply.matchAll(eventRegex)) as any[];
    for (const m of evMatches) {
      if (m && m.length >= 5) {
        await supabase.from('events').insert([{ user_id: stringId, title: m[1].trim(), event_date: m[2], priority: m[3].toLowerCase(), is_recurring: m[4].toLowerCase() === 'true', last_notified_year: new Date().getFullYear() - 1 }]);
        aiReply = aiReply.replace(m[0], '').trim();
      }
    }

    // INTERCEPTOR: DESCANSO
    const interruptRegex = /\[?DESATIVAR_ROTINA:\s*(\d{4}-\d{2}-\d{2})\]?/i;
    const intMatch = aiReply.match(interruptRegex);
    if (intMatch && intMatch[1]) {
      await supabase.from('routine_exceptions').insert([{ user_id: stringId, exception_date: intMatch[1], type: 'pause_all' }]);
      aiReply = aiReply.replace(intMatch[0], '').trim() + "\n\n*(Protocolo de descanso ativado).*";
    }

    // INTERCEPTOR: AGENDA (Google)
    const scheduleRegex = /\[?AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i;
    const sMatch = aiReply.match(scheduleRegex);
    if (sMatch && sMatch.length >= 4) {
      const res = await createGoogleEvent(sMatch[1].trim(), sMatch[2].trim(), parseInt(sMatch[3]));
      aiReply = aiReply.replace(sMatch[0], '').trim() + `\n\n🗓️ **Ação Agenda:** ${res}`;
    }

    // 6. PERSISTÊNCIA E TELEGRAM
    await supabase.from('brain').insert([{ content: messageText, category, user_id: stringId, embedding: queryEmbedding, metadata: { ai_reply: aiReply, user: authorName } }]);
    await sendTelegram(chatId, aiReply);

    const { count } = await supabase.from('brain').select('*', { count: 'exact', head: true }).eq('user_id', stringId).eq('category', 'info');
    if (count && count >= 20) await compactMemory(stringId, authorName);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}