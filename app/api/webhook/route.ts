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

    // 1. CAMADA L3 (ESTADO ATUAL DO USUÁRIO - A NOVA MEMÓRIA INTERMEDIÁRIA)
    // Aqui buscamos não só o nome, mas o "Dossiê" atualizado do usuário
    const { data: userProfile } = await supabase
      .from('users')
      .select('nickname, current_context') // Você precisa adicionar essa coluna 'current_context' no banco
      .eq('id', telegramUserId)
      .single();
      
    const authorName = userProfile?.nickname || userFirstName;
    const currentContextL3 = userProfile?.current_context || "Contexto base ainda não definido.";

    // 2. CAMADA HD (BUSCA VETORIAL PROFUNDA)
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

    // 3. CAMADA RAM (O FIO DA CONVERSA)
    const { data: history } = await supabase
      .from('brain')
      .select('content, category, metadata')
      .eq('user_id', telegramUserId)
      .neq('category', 'noise') 
      .order('created_at', { ascending: false })
      .limit(15); 
    
    const ramMemory = history?.reverse().map(h => {
      const cleanAiReply = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
      return `${authorName}: ${h.content}\nJarvis: ${cleanAiReply}`;
    }).join('\n') || "Nenhuma conversa útil recente.";

    // 4. A CACHE (O MOTOR DE IA COM INJEÇÃO ESTRUTURADA)
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const projectTag = (messageText.match(/#(\w+)/i) || [])[1];

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | DATA: ${dataAtual}

[ESTADO ATUAL DO USUÁRIO (L3 - SEU CONTEXTO MESTRE)]
${currentContextL3}

[HISTÓRICO DA CONVERSA (RAM)]
${ramMemory}

[BUSCA PROFUNDA (HD)]
${hdContext || "Nada relevante encontrado no HD para esta mensagem."}

[MENSAGEM ATUAL]
"${messageText}"

DIRETRIZES:
1. Você TEM acesso a todas as memórias acima. NUNCA diga "não tenho acesso" ou "não lembro".
2. Se o usuário perguntar sobre a rotina dele, as respostas estão no bloco [ESTADO ATUAL].
3. OBRIGATÓRIO: Termine classificando: [CLASSE: noise] para conversas fiadas/confirmações; [CLASSE: info] para dados e decisões.
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    // 5. PROCESSAMENTO E INTERCEPTADORES
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // ... (Agendamentos do Google Calendar permanecem inalterados) ...

    // 6. PERSISTÊNCIA NA RAM
    await supabase.from('brain').insert([{
      content: messageText,
      category: category, 
      project_tag: projectTag || 'Jarvis',
      user_id: telegramUserId,
      embedding: queryEmbedding,
      metadata: { ai_reply: aiReply, user: authorName }
    }]);

    await sendTelegram(chatId, aiReply);

    // 7. AUTO-COMPACTAÇÃO (Atualiza a L3 e o HD)
    const { count } = await supabase.from('brain').select('*', { count: 'exact', head: true }).eq('user_id', telegramUserId).eq('category', 'info');
    if (count && count >= 20) {
       compactMemory(telegramUserId.toString(), authorName);
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
      }
