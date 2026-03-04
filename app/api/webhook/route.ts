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

    // 1. CAMADA L3 (ESTADO ATUAL DO USUÁRIO - MEMÓRIA INTERMEDIÁRIA)
    // Puxa o Dossiê injetado via SQL e o apelido
    const { data: userProfile } = await supabase
      .from('users')
      .select('nickname, current_context')
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
        match_threshold: 0.4, // Limiar mais baixo para ser mais assertivo
        match_count: 2 
      });
      if (search?.length) {
        hdContext = search.map((r: any) => `[Memória Antiga]: ${r.summary}`).join('\n');
      }
    }

    // 3. CAMADA RAM (O FIO DA CONVERSA - ÚLTIMAS 15 MENSAGENS ÚTEIS)
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

    // 4. CAMADA CACHE (O MOTOR DE IA COM DIRETRIZES RÍGIDAS)
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const projectTag = (messageText.match(/#(\w+)/i) || [])[1];

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | DATA: ${dataAtual}

[ESTADO ATUAL DO USUÁRIO (L3 - CONTEXTO MESTRE)]
${currentContextL3}

[HISTÓRICO DA CONVERSA (RAM)]
${ramMemory}

[BUSCA PROFUNDA (HD)]
${hdContext || "Nada relevante encontrado no HD para esta mensagem."}

[MENSAGEM ATUAL]
"${messageText}"

DIRETRIZES:
1. Você TEM acesso a todas as memórias acima. NUNCA diga que "não sabe" ou "não tem acesso" ao que está no ESTADO ATUAL (L3) ou na RAM.
2. Seja direto, empático e técnico quando necessário.
3. OBRIGATÓRIO: Termine classificando: [CLASSE: noise] para saudações/confirmações; [CLASSE: info] para dados e decisões.
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    // 5. PROCESSAMENTO DE CLASSIFICAÇÃO E INTERCEPTADORES (AGENDA)
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // Interceptor: Alterar Agenda
    const updateRegex = /\[ALTERAR_AGENDA:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]/i;
    const updateMatch = aiReply.match(updateRegex);
    if (updateMatch) {
      const result = await updateGoogleEvent(updateMatch[1].trim(), updateMatch[2].trim(), updateMatch[3].trim(), parseInt(updateMatch[4]));
      aiReply += `\n\n🗓️ **Ação:** ${result}`;
    }

    // Interceptor: Agendar Novo
    const scheduleRegex = /\[AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]/i;
    const scheduleMatch = aiReply.match(scheduleRegex);
    if (scheduleMatch) {
      const result = await createGoogleEvent(scheduleMatch[1].trim(), scheduleMatch[2].trim(), parseInt(scheduleMatch[3]));
      aiReply += `\n\n🗓️ **Ação:** ${result}`;
    }

    // 6. PERSISTÊNCIA NA RAM (Tabela Brain)
    await supabase.from('brain').insert([{
      content: messageText,
      category: category, 
      project_tag: projectTag || 'Jarvis',
      user_id: telegramUserId,
      embedding: queryEmbedding,
      metadata: { ai_reply: aiReply, user: authorName }
    }]);

    await sendTelegram(chatId, aiReply);

    // 7. AUTO-COMPACTAÇÃO (Gatilho para manter a L3 atualizada)
    const { count } = await supabase
      .from('brain')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', telegramUserId)
      .eq('category', 'info');

    if (count && count >= 20) {
       compactMemory(telegramUserId.toString(), authorName);
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}
