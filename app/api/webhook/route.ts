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
    const { data: userProfile } = await supabase.from('users').select('nickname, current_context').eq('id', stringId).single();
    const authorName = userProfile?.nickname || userFirstName;
    const currentContextL3 = userProfile?.current_context || "ERRO_ID_NAO_LOCALIZADO";

    // 2. CAMADA HD (VETORIAL - BUSCA PROFUNDA)
    const queryEmbedding = await generateEmbedding(messageText);
    let hdContext = "";
    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', { query_embedding: queryEmbedding, match_threshold: 0.4, match_count: 2 });
      if (search?.length) hdContext = search.map((r: any) => `[Memória Antiga]: ${r.summary}`).join('\n');
    }

    // 3. CAMADA RAM (O FIO DA CONVERSA)
    const { data: history } = await supabase.from('brain').select('content, category, metadata').eq('user_id', stringId).neq('category', 'noise').order('created_at', { ascending: false }).limit(15); 
    const ramMemory = history?.reverse().map(h => {
      const cleanAiReply = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
      return `${authorName}: ${h.content}\nJarvis: ${cleanAiReply}`;
    }).join('\n') || "Iniciando protocolo de diálogo.";

    // 4. CAMADA CACHE (MOTOR DE INTELIGÊNCIA)
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | DATA: ${dataAtual}

[DADOS DE PERFIL (L3)]
${currentContextL3}

[CONTEXTO RECENTE (RAM)]
${ramMemory}

[MEMÓRIA DE LONGO PRAZO (HD)]
${hdContext || "Nenhuma lembrança relevante ativada."}

MENSAGEM: "${messageText}"

MISSÃO E DIRETRIZES:
1. FOCO E INVESTIGAÇÃO: Responda ao usuário. Se mencionar datas ou pessoas, investigue para descobrir a data exata.
2. SALVAMENTO PROATIVO: Se identificar uma data importante, inclua ao final: [SALVAR_EVENTO: Título | YYYY-MM-DD | alta/media/baixa | true/false].
3. GESTÃO DE DESCANSO (NOVO): Se o usuário falar de folga, feriado, ou que quer dormir mais, ofereça pausar a rotina. Use o comando invisível [DESATIVAR_ROTINA: YYYY-MM-DD] com a data correspondente à folga.
4. PERSONALIDADE: Estilo Stark (elegante/sarcástico). PROIBIÇÃO: Nunca repita cabeçalhos, variáveis ou comandos em colchetes visíveis na resposta.
5. RIGOR TÉCNICO: Mantenha o Framework de 4 Etapas e o Estacionamento de Ideias para projetos de código.
6. CLASSIFICAÇÃO: Termine com [CLASSE: info] ou [CLASSE: noise].
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    // 5. PROCESSAMENTO E INTERCEPTORES
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // Interceptor: Eventos Proativos
    const eventRegex = /\[SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\]/i;
    const eventMatch = aiReply.match(eventRegex);
    if (eventMatch) {
      await supabase.from('events').insert([{ user_id: stringId, title: eventMatch[1].trim(), event_date: eventMatch[2], priority: eventMatch[3].toLowerCase(), is_recurring: eventMatch[4].toLowerCase() === 'true', last_notified_year: new Date().getFullYear() - 1 }]);
      aiReply = aiReply.replace(eventRegex, '').trim() + "\n\n*(Evento registrado nos meus radares).*";
    }

    // Interceptor: Gestão de Descanso (Interruptor de Comodidade)
    const interruptRegex = /\[DESATIVAR_ROTINA:\s*(\d{4}-\d{2}-\d{2})\]/i;
    const interruptMatch = aiReply.match(interruptRegex);
    if (interruptMatch) {
      await supabase.from('routine_exceptions').insert([{ user_id: stringId, exception_date: interruptMatch[1], type: 'pause_all' }]);
      aiReply = aiReply.replace(interruptRegex, '').trim() + "\n\n*(Protocolo de descanso ativado. Alarmes silenciados para esta data).*";
    }

    // Interceptor: Agenda Google
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
    await supabase.from('brain').insert([{ content: messageText, category, user_id: stringId, embedding: queryEmbedding, metadata: { ai_reply: aiReply, user: authorName } }]);
    await sendTelegram(chatId, aiReply);

    // 7. AUTO-COMPACTAÇÃO
    const { count } = await supabase.from('brain').select('*', { count: 'exact', head: true }).eq('user_id', stringId).eq('category', 'info');
    if (count && count >= 20) compactMemory(stringId, authorName);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}