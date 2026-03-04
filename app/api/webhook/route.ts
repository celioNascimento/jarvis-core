import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, generateEmbedding, sendTelegram, compactMemory } from '@/lib/jarvis';
import { createGoogleEvent, updateGoogleEvent } from '@/lib/google';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageText = body.message?.text || "";
    const chatId = body.message?.chat?.id;
    const telegramUserId = body.message?.from?.id;
    const userFirstName = body.message?.from?.first_name || "Usuário";
    const isBot = body.message?.from?.is_bot || false;

    if (isBot || !messageText) return NextResponse.json({ ok: true });

    // ⚡ TRAVA DE SINAPSE: Forçamos o ID a ser uma String para bater com o BigInt do banco
    const stringId = String(telegramUserId);

    // 1. CAMADA L3 (ESTADO ATUAL - O DOSSIÊ)
    const { data: userProfile, error: profileError } = await supabase
      .from('users')
      .select('nickname, current_context')
      .eq('id', stringId) // <--- USANDO A STRINGID AGORA
      .single();
      
    if (profileError) console.error("Erro ao acessar L3:", profileError.message);

    // Se o banco falhar, o authorName será o nome do Telegram, mas o Dossiê terá o aviso
    const authorName = userProfile?.nickname || userFirstName;
    const currentContextL3 = userProfile?.current_context || "ATENÇÃO: Dossiê não localizado no banco para o ID " + stringId;

    // 2. CAMADA HD (BUSCA VETORIAL)
    const queryEmbedding = await generateEmbedding(messageText);
    let hdContext = "";
    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', { 
        query_embedding: queryEmbedding, 
        match_threshold: 0.4, 
        match_count: 2 
      });
      if (search?.length) {
        hdContext = search.map((r: any) => `[Memória Antiga]: ${r.summary}`).join('\n');
      }
    }

    // 3. CAMADA RAM (HISTÓRICO RECENTE)
    const { data: history } = await supabase
      .from('brain')
      .select('content, category, metadata')
      .eq('user_id', stringId) // <--- TAMBÉM USANDO STRINGID AQUI
      .neq('category', 'noise') 
      .order('created_at', { ascending: false })
      .limit(15); 
    
    const ramMemory = history?.reverse().map(h => {
      const cleanAiReply = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
      return `${authorName}: ${h.content}\nJarvis: ${cleanAiReply}`;
    }).join('\n') || "Iniciando nova linha de raciocínio.";

    // 4. CAMADA CACHE (O PROMPT MESTRE)
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const projectTag = (messageText.match(/#(\w+)/i) || [])[1];

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | DATA: ${dataAtual}

[ESTADO ATUAL DO USUÁRIO (L3 - CONTEXTO MESTRE)]
${currentContextL3}

[HISTÓRICO RECENTE (RAM)]
${ramMemory}

[MENSAGEM ATUAL]
"${messageText}"

DIRETRIZES DE JARVIS:
- Você é um assistente pessoal focado em performance e rigor técnico.
- Se o campo [ESTADO ATUAL] disser "Dossiê não localizado", peça para o usuário rodar o comando SQL de cadastro.
- Se o Dossiê estiver presente, use os horários lá descritos (Acorda 05h, Academia 06h20, Trabalho 08h) para responder.
- NUNCA responda que não sabe se a informação está no Dossiê acima.
- Classifique no final: [CLASSE: noise] ou [CLASSE: info].
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    // 5. PROCESSAMENTO DE CATEGORIA E AGENDA
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // (Interceptors de Agenda mantidos...)
    const updateRegex = /\[ALTERAR_AGENDA:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]/i;
    const updateMatch = aiReply.match(updateRegex);
    if (updateMatch) {
      const result = await updateGoogleEvent(updateMatch[1].trim(), updateMatch[2].trim(), updateMatch[3].trim(), parseInt(updateMatch[4]));
      aiReply += `\n\n🗓️ **Ação:** ${result}`;
    }

    const scheduleRegex = /\[AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]/i;
    const scheduleMatch = aiReply.match(scheduleRegex);
    if (scheduleMatch) {
      const result = await createGoogleEvent(scheduleMatch[1].trim(), scheduleMatch[2].trim(), parseInt(scheduleMatch[3]));
      aiReply += `\n\n🗓️ **Ação:** ${result}`;
    }

    // 6. PERSISTÊNCIA NA RAM
    await supabase.from('brain').insert([{
      content: messageText,
      category: category, 
      project_tag: projectTag || 'Jarvis',
      user_id: stringId, // <--- PERSISTINDO COMO STRING
      embedding: queryEmbedding,
      metadata: { ai_reply: aiReply, user: authorName }
    }]);

    await sendTelegram(chatId, aiReply);

    // 7. AUTO-COMPACTAÇÃO
    const { count } = await supabase.from('brain').select('*', { count: 'exact', head: true }).eq('user_id', stringId).eq('category', 'info');
    if (count && count >= 20) {
       compactMemory(stringId, authorName);
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}
