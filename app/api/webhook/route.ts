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

    // 1. IDENTIFICAÇÃO DO PERFIL (MÚLTIPLOS USUÁRIOS)
    const { data: userProfile } = await supabase.from('users').select('nickname').eq('id', telegramUserId).single();
    const authorName = userProfile?.nickname || userFirstName;

    // 2. HD: LEITURA DUPLA (SNAPSHOT FIXO + BUSCA VETORIAL)
    // A. Pega o resumo mais recente (O "Manual de Instruções" do usuário)
    const { data: snapshot } = await supabase
      .from('memories')
      .select('summary')
      .eq('user_id', telegramUserId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    let hdContext = snapshot ? `[CONTEXTO PRINCIPAL]: ${snapshot.summary}\n` : "";

    // B. Pega memórias antigas por similaridade
    const queryEmbedding = await generateEmbedding(messageText);
    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', { 
        query_embedding: queryEmbedding, 
        match_threshold: 0.5, 
        match_count: 2 
      });
      if (search?.length) {
        hdContext += search.map((r: any) => `[Memória Específica]: ${r.summary}`).join('\n');
      }
    }
    
    if (!hdContext) hdContext = "Nenhum dado de longo prazo disponível.";

    // 3. RAM: MEMÓRIA DE CURTO PRAZO (Filtrando Ruído)
    const { data: history } = await supabase
      .from('brain')
      .select('content, category, metadata')
      .eq('user_id', telegramUserId)
      .neq('category', 'noise') 
      .order('created_at', { ascending: false })
      .limit(12);
    
    const ramMemory = history?.reverse().map(h => {
      const cleanAiReply = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
      return `${authorName}: ${h.content}\nJarvis: ${cleanAiReply}`;
    }).join('\n') || "Iniciando nova linha de raciocínio.";

    // 4. CACHE: O MOTOR DE IA
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const projectTag = (messageText.match(/#(\w+)/i) || [])[1];

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO ATUAL: ${authorName} | DATA: ${dataAtual}

[HISTÓRICO RECENTE (RAM)]
${ramMemory}

[MEMÓRIA DE LONGO PRAZO (HD E SNAPSHOTS)]
${hdContext}

[MENSAGEM ATUAL]
"${messageText}"

DIRETRIZES:
1. Use o HISTÓRICO e a MEMÓRIA para manter o fio da conversa e não pedir repetição de contexto.
2. Termine sua resposta com uma classificação de importância:
   - Se for saudação/vazio: [CLASSE: noise]
   - Se houver horários, planos, decisões ou dados: [CLASSE: info]
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    // 5. PROCESSAMENTO DE CLASSIFICAÇÃO
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // 6. INTERCEPTADORES (AGENDA GOOGLE)
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

    // 7. PERSISTÊNCIA NO BRAIN
    await supabase.from('brain').insert([{
      content: messageText,
      category: category, 
      project_tag: projectTag || 'Jarvis_AI',
      user_id: telegramUserId,
      embedding: queryEmbedding,
      metadata: { ai_reply: aiReply, user: authorName }
    }]);

    await sendTelegram(chatId, aiReply);

    // 8. AUTO-COMPACTAÇÃO (Executa após o envio)
    const { count } = await supabase.from('brain').select('*', { count: 'exact', head: true }).eq('user_id', telegramUserId).eq('category', 'info');
    if (count && count >= 10) {
       // Dispara a compactação da pasta lib
       compactMemory(telegramUserId.toString(), authorName);
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}
