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

    // TRAVA DE SEGURANÇA PARA O ID (Garante que o banco entenda o número gigante do Telegram)
    const stringId = String(telegramUserId);

    // 1. CAMADA L3 (ESTADO ATUAL DO USUÁRIO - MEMÓRIA INTERMEDIÁRIA)
    const { data: userProfile, error: profileError } = await supabase
      .from('users')
      .select('nickname, current_context')
      .eq('id', stringId)
      .single();
      
    if (profileError) console.error("Erro na L3:", profileError.message);

    const authorName = userProfile?.nickname || userFirstName;
    const currentContextL3 = userProfile?.current_context || "Contexto base ainda não definido no banco de dados.";

    // 2. CAMADA HD (BUSCA VETORIAL PROFUNDA)
    const queryEmbedding = await generateEmbedding(messageText);
    let hdContext = "";
    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', { 
        query_embedding: queryEmbedding, 
        match_threshold: 0.4, // Limiar generoso para não perder detalhes
        match_count: 2 
      });
      if (search?.length) {
        hdContext = search.map((r: any) => `[Memória Antiga]: ${r.summary}`).join('\n');
      }
    }

    // 3. CAMADA RAM (O FIO DA CONVERSA - ÚLTIMAS 15 MENSAGENS)
    const { data: history } = await supabase
      .from('brain')
      .select('content, category, metadata')
      .eq('user_id', stringId)
      .neq('category', 'noise') 
      .order('created_at', { ascending: false })
      .limit(15); 
    
    const ramMemory = history?.reverse().map(h => {
      const cleanAiReply = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
      return `${authorName}: ${h.content}\nJarvis: ${cleanAiReply}`;
    }).join('\n') || "Nenhuma conversa útil recente.";

    // 4. CAMADA CACHE (MOTOR DE IA COM CHECKMATE CONTRA AMNÉSIA E DIRETRIZES DE TRABALHO)
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const projectTag = (messageText.match(/#(\w+)/i) || [])[1];

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | DATA: ${dataAtual}

[ESTADO ATUAL DO USUÁRIO (L3 - SEU CONTEXTO MESTRE)]
${currentContextL3}

[HISTÓRICO DA CONVERSA (RAM)]
${ramMemory}

[BUSCA PROFUNDA (HD)]
${hdContext || "Nenhuma memória de longo prazo acionada para esta mensagem."}

[MENSAGEM ATUAL DO USUÁRIO]
"${messageText}"

DIRETRIZES OBRIGATÓRIAS DE EXECUÇÃO (CRÍTICO):
1. PROIBIÇÃO DE AMNÉSIA: Você TEM ACESSO ABSOLUTO às memórias acima. NUNCA diga frases como "não tenho informações", "memória vazia" ou "não sei sua rotina". Use o [ESTADO ATUAL] como verdade absoluta.
2. REGRAS DE PROJETOS ('Procuro Quem Faça' / 'ExpertFrotas'): 
   - Ao implementar, bloqueie demandas fora do escopo.
   - Em dias úteis (pós-18h) e feriados/finais de semana, siga o princípio FIFO e o Framework de 4 Etapas (Repositório, Laboratório, Homologação e Vitrine).
   - Novas ideias devem ser enviadas ao "Estacionamento de Ideias", recusando execução imediata.
   - Sempre exija 'Confirmação de Layout' do usuário antes de avançar camadas visuais. A prioridade é UX visual e rigor técnico.
3. CÓDIGO E DÚVIDAS: Se o usuário enviar código, altere APENAS o solicitado (mantenha estrutura e variáveis originais). Se ele tirar uma dúvida no meio de uma explicação, sane de forma curta e use uma linha visual (---) para retomar do ponto exato onde pararam.
4. ROTEIROS: A estrutura de rotina é imutável, altere apenas tarefas dentro dos blocos de tempo.
5. CLASSIFICAÇÃO: Termine sua resposta (na última linha) com:
   [CLASSE: noise] (Para saudações, confirmações curtas ou conversa fiada).
   [CLASSE: info] (Para horários, planos, códigos, ideias ou decisões).
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    // 5. PROCESSAMENTO DE CLASSIFICAÇÃO E INTERCEPTADORES
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

    // 6. PERSISTÊNCIA NA RAM
    await supabase.from('brain').insert([{
      content: messageText,
      category: category, 
      project_tag: projectTag || 'Jarvis',
      user_id: stringId,
      embedding: queryEmbedding,
      metadata: { ai_reply: aiReply, user: authorName }
    }]);

    await sendTelegram(chatId, aiReply);

    // 7. GATILHO DE AUTO-COMPACTAÇÃO
    const { count } = await supabase
      .from('brain')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', stringId)
      .eq('category', 'info');

    if (count && count >= 20) {
       compactMemory(stringId, authorName);
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis Webhook:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}
