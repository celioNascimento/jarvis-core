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
    const horaAtual = new Date().getHours();

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | DATA E HORA ATUAL: ${dataAtual} (Hora: ${horaAtual}h)

[DADOS DE PERFIL (L3)]
${currentContextL3}

[CONTEXTO RECENTE (RAM)]
${ramMemory}

[MEMÓRIA DE LONGO PRAZO (HD)]
${hdContext || "Nenhuma lembrança relevante ativada."}

MENSAGEM: "${messageText}"

MISSÃO E DIRETRIZES:
1. CONSCIÊNCIA TEMPORAL: Observe a "Hora" atual acima. Use a saudação correta (Bom dia, Boa tarde, Boa noite).
2. FOCO E TOM: Seja amigável, empático, mas mantenha a elegância Stark. Não pareça um robô gerando logs.
3. SALVAMENTO PROATIVO: Se o usuário passar datas importantes, use o comando interno OBRIGATORIAMENTE ENTRE COLCHETES. Você pode gerar mais de um comando se houver mais de uma data:
   [SALVAR_EVENTO: Título do Evento | YYYY-MM-DD | alta/media/baixa | true/false]
4. GESTÃO DE DESCANSO: Se o usuário mencionar folga ou feriado, ofereça pausar a rotina usando: [DESATIVAR_ROTINA: YYYY-MM-DD].
5. PROIBIÇÃO ABSOLUTA: O usuário NÃO PODE VER os comandos [SALVAR_EVENTO] ou [DESATIVAR_ROTINA]. Gere-os isolados no final da mensagem para o sistema processar. Nunca repita variáveis de sistema.
6. RIGOR TÉCNICO: Mantenha o Framework de 4 Etapas e o Estacionamento de Ideias para projetos de código.
7. CLASSIFICAÇÃO: Termine na última linha com [CLASSE: info] ou [CLASSE: noise].
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    // 5. PROCESSAMENTO E INTERCEPTORES
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // Interceptor: Eventos Proativos (Usando Loop para capturar MÚLTIPLOS eventos e aceitar falhas de formatação)
    const eventRegex = /\[?SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\]?/i;
    let eventMatch;
    let eventosSalvos = 0;
    while ((eventMatch = aiReply.match(eventRegex))) {
      await supabase.from('events').insert([{ user_id: stringId, title: eventMatch[1].trim(), event_date: eventMatch[2], priority: eventMatch[3].toLowerCase(), is_recurring: eventMatch[4].toLowerCase() === 'true', last_notified_year: new Date().getFullYear() - 1 }]);
      aiReply = aiReply.replace(eventMatch[0], '').trim(); // Remove o comando exato que foi encontrado
      eventosSalvos++;
    }
    if (eventosSalvos > 0) {
      aiReply += `\n\n*(✔️ ${eventosSalvos} evento(s) classificado(s) e registrado(s) nos meus radares).*`;
    }

    // Interceptor: Gestão de Descanso
    const interruptRegex = /\[?DESATIVAR_ROTINA:\s*(\d{4}-\d{2}-\d{2})\]?/i;
    const interruptMatch = aiReply.match(interruptRegex);
    if (interruptMatch) {
      await supabase.from('routine_exceptions').insert([{ user_id: stringId, exception_date: interruptMatch[1], type: 'pause_all' }]);
      aiReply = aiReply.replace(interruptMatch[0], '').trim() + "\n\n*(Protocolo de descanso ativado. Alarmes silenciados para esta data).*";
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