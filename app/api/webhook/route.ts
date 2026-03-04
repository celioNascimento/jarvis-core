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

    // 2. HD: LEITURA DUPLA IMPERCEPTÍVEL (SNAPSHOT + BUSCA VETORIAL)
    // A. Snapshot (A identidade e contexto permanente que nunca apaga)
    const { data: snapshot } = await supabase
      .from('memories')
      .select('summary')
      .eq('user_id', telegramUserId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    let hdContext = snapshot ? `[CONTEXTO PRINCIPAL FIXO]: ${snapshot.summary}\n` : "";

    // B. Busca Vetorial (Memórias específicas do passado com limiar tolerante)
    const queryEmbedding = await generateEmbedding(messageText);
    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', { 
        query_embedding: queryEmbedding, 
        match_threshold: 0.4, // Tolerância maior para não deixar passar detalhes
        match_count: 3 
      });
      if (search?.length) {
        hdContext += search.map((r: any) => `[Memória Recuperada]: ${r.summary}`).join('\n');
      }
    }
    
    if (!hdContext) hdContext = "Aguardando geração do primeiro snapshot.";

    // 3. RAM: MEMÓRIA DE CURTO PRAZO (O Fio da Meada)
    const { data: history } = await supabase
      .from('brain')
      .select('content, category, metadata')
      .eq('user_id', telegramUserId)
      .neq('category', 'noise') // Filtro de ruído mantido
      .order('created_at', { ascending: false })
      .limit(20); // Fôlego aumentado para não perder contexto de áudios/textos longos
    
    const ramMemory = history?.reverse().map(h => {
      const cleanAiReply = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
      return `${authorName}: ${h.content}\nJarvis: ${cleanAiReply}`;
    }).join('\n') || "Iniciando nova linha de raciocínio.";

    // 4. CACHE: MOTOR DE IA COM BLINDAGEM CONTRA AMNÉSIA
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const projectTag = (messageText.match(/#(\w+)/i) || [])[1];

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO ATUAL: ${authorName} | DATA: ${dataAtual}

[MEMÓRIA DE LONGO PRAZO (HD)]
${hdContext}

[HISTÓRICO RECENTE (RAM)]
${ramMemory}

[MENSAGEM ATUAL DO USUÁRIO]
"${messageText}"

DIRETRIZES DE EXECUÇÃO (CRÍTICO):
1. Você TEM ACESSO MENTAL aos blocos acima. A transição deve ser invisível e natural. NUNCA diga frases como "não tenho acesso a mensagens anteriores" ou "minha memória está vazia". Assuma os dados como verdades.
2. SÓ agende ou altere compromissos se houver comandos claros.
3. OBRIGATÓRIO: Termine sua resposta classificando a mensagem:
   - Se for apenas saudação, ok ou confirmação simples: [CLASSE: noise]
   - Se houver horários, ideias, rotinas ou fatos: [CLASSE: info]
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

    // 7. PERSISTÊNCIA NO BRAIN (Gravando na RAM)
    await supabase.from('brain').insert([{
      content: messageText,
      category: category, 
      project_tag: projectTag || 'Jarvis_AI',
      user_id: telegramUserId,
      embedding: queryEmbedding,
      metadata: { ai_reply: aiReply, user: authorName }
    }]);

    await sendTelegram(chatId, aiReply);

    // 8. AUTO-COMPACTAÇÃO INVISÍVEL
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
