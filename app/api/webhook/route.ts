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

    const stringId = String(telegramUserId);

    // 1. CAMADA L3 (ESTADO ATUAL)
    const { data: userProfile } = await supabase
      .from('users')
      .select('nickname, current_context')
      .eq('id', telegramUserId)
      .single();
      
    const authorName = userProfile?.nickname || userFirstName;
    const currentContextL3 = userProfile?.current_context || "ERRO_ID_NAO_LOCALIZADO";

    // 2. CAMADA HD (VETORIAL)
    const queryEmbedding = await generateEmbedding(messageText);
    let hdContext = "";
    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', { 
        query_embedding: queryEmbedding, 
        match_threshold: 0.4, 
        match_count: 2 
      });
      if (search?.length) hdContext = search.map((r: any) => `[Histórico]: ${r.summary}`).join('\n');
    }

    // 3. CAMADA RAM (MEMÓRIA RECENTE)
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
    }).join('\n') || "Iniciando diálogo.";

    // 4. CAMADA CACHE (O CÉREBRO)
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | DATA: ${dataAtual}

[DADOS DE PERFIL (L3)]
${currentContextL3}

[CONTEXTO RECENTE (RAM)]
${ramMemory}

MENSAGEM DO USUÁRIO: "${messageText}"

MISSÃO E DIRETRIZES:
1. FOCO EM SOLUÇÃO: Não repita o que o usuário disse. Analise os dados e proponha a otimização matemática da rotina.
2. LINGUAGEM: Seja robusto, direto e sem "encher linguiça". Use listas se necessário. Evite termos técnicos (como L3, RAM, SQL) a menos que ocorra o erro "ERRO_ID_NAO_LOCALIZADO".
3. TRATAMENTO DE ERRO: Se [DADOS DE PERFIL] for "ERRO_ID_NAO_LOCALIZADO", explique que houve uma falha técnica na identificação do ID ${telegramUserId} e peça para validar no banco.
4. LÓGICA DE ROTINA: Considere: Despertar 05h | Sofá 50min | Saída 06h20 | Academia -> Trabalho 10min | Entrada 08h.
5. CLASSIFICAÇÃO: Termine com [CLASSE: info] ou [CLASSE: noise].
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // 5. INTERCEPTORES DE AGENDA
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

    // 6. PERSISTÊNCIA
    await supabase.from('brain').insert([{
      content: messageText,
      category: category, 
      user_id: telegramUserId,
      embedding: queryEmbedding,
      metadata: { ai_reply: aiReply, user: authorName }
    }]);

    await sendTelegram(chatId, aiReply);

    // 7. COMPACTAÇÃO
    const { count } = await supabase.from('brain').select('*', { count: 'exact', head: true }).eq('user_id', telegramUserId).eq('category', 'info');
    if (count && count >= 20) compactMemory(stringId, authorName);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}
