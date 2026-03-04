import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, generateEmbedding, sendTelegram, compactMemory } from '@/lib/jarvis';
import { createGoogleEvent, updateGoogleEvent } from '@/lib/google';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const message = body.message;
    let messageText = message?.text || "";
    
    // --- 🎤 MOTOR DE AUDIÇÃO (WHISPER FIX) ---
    if (message?.voice) {
      const fileId = message.voice.file_id;
      // 1. Pega o caminho do arquivo
      const getFile = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
      const fileData = await getFile.json();
      
      if (fileData.ok) {
        const filePath = fileData.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${filePath}`;
        
        // 2. Baixa o áudio
        const audioRes = await fetch(fileUrl);
        const audioBuffer = await audioRes.arrayBuffer();
        
        // 3. Prepara o FormData de forma compatível com a API OpenAI
        const formData = new FormData();
        const file = new File([audioBuffer], 'audio.ogg', { type: 'audio/ogg' });
        formData.append('file', file);
        formData.append('model', 'whisper-1');

        const transcriptionRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
          body: formData
        });
        
        const transcriptionData = await transcriptionRes.json();
        messageText = transcriptionData.text || "";
        console.log("🎤 Transcrição concluída:", messageText);
      }
    }

    const chatId = message?.chat?.id;
    const telegramUserId = message?.from?.id;
    const userFirstName = message?.from?.first_name || "Usuário";

    if (!messageText || chatId == null || telegramUserId == null) return NextResponse.json({ ok: true });

    const stringId = String(telegramUserId);

    // 1. CAMADA L3
    const { data: userProfile } = await supabase.from('users').select('nickname, current_context').eq('id', stringId).single();
    const authorName = userProfile?.nickname || userFirstName;
    const currentContextL3 = userProfile?.current_context || "Sem dossiê.";

    // 2. CAMADA HD
    const queryEmbedding = await generateEmbedding(messageText);
    let hdContext = "";
    if (queryEmbedding) {
      const { data: search }: { data: any[] | null } = await supabase.rpc('match_memories', { query_embedding: queryEmbedding, match_threshold: 0.4, match_count: 2 });
      if (search && search.length > 0) hdContext = search.map((r) => `[Memória Antiga]: ${r.summary}`).join('\n');
    }

    // 3. CAMADA RAM
    const { data: history } = await supabase.from('brain').select('content, category, metadata').eq('user_id', stringId).neq('category', 'noise').order('created_at', { ascending: false }).limit(10); 
    const ramMemory = (history || []).reverse().map((h: any) => `${authorName}: ${h.content}\nJarvis: ${(h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim()}`).join('\n');

    // 4. CAMADA CACHE (Londrina)
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | AGORA: ${dataAtual}

[PERFIL L3]
${currentContextL3}

[CONVERSA ATUAL]
${ramMemory}

MENSAGEM: "${messageText}"

MISSÃO:
1. PERSONALIDADE: Você é o Jarvis (Tony Stark style). Seja direto e eficiente. 
2. REGRAS DE SAUDAÇÃO: NÃO fale a hora. NÃO diga "Boa noite" ou "Bom dia" em todas as mensagens. Apenas responda ao que foi dito de forma natural.
3. GATILHOS: 
   - [SALVAR_EVENTO]: Datas recorrentes (aniversários).
   - [DESATIVAR_ROTINA]: Só se eu disser "folga" ou "feriado".
   - [AGENDAR]: Tarefas na agenda.
4. CLASSE: [CLASSE: info] ou [CLASSE: noise].
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    // 5. INTERCEPTORES
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // Eventos
    const eventRegex = /\[?SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\]?/gi;
    const evMatches = Array.from(aiReply.matchAll(eventRegex)) as any[];
    for (const m of evMatches) {
      if (m && m.length >= 5) {
        await supabase.from('events').insert([{ user_id: stringId, title: m[1].trim(), event_date: m[2], priority: m[3].toLowerCase(), is_recurring: m[4].toLowerCase() === 'true', last_notified_year: new Date().getFullYear() - 1 }]);
        aiReply = aiReply.replace(m[0], '').trim();
      }
    }

    // Google Agenda
    const scheduleRegex = /\[?AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i;
    const sMatch = aiReply.match(scheduleRegex);
    if (sMatch && sMatch.length >= 4) {
      const res = await createGoogleEvent(sMatch[1].trim(), sMatch[2].trim(), parseInt(sMatch[3]));
      aiReply = aiReply.replace(sMatch[0], '').trim() + `\n\n🗓️ **Agenda:** ${res}`;
    }

    // 6. PERSISTÊNCIA
    await supabase.from('brain').insert([{ content: messageText, category, user_id: stringId, embedding: queryEmbedding, metadata: { ai_reply: aiReply, user: authorName } }]);
    await sendTelegram(chatId, aiReply);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}