import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, generateEmbedding, sendTelegram, compactMemory } from '@/lib/jarvis';
import { createGoogleEvent, updateGoogleEvent } from '@/lib/google';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    
    // Extração segura de dados (Deixe o TS inferir ou use fallbacks)
    const messageText = body.message?.text || "";
    const chatId = body.message?.chat?.id;
    const telegramUserId = body.message?.from?.id;
    const userFirstName = body.message?.from?.first_name || "Usuário";
    const isBot = body.message?.from?.is_bot || false;

    // Se não for uma mensagem válida, encerra sem erro
    if (isBot || !messageText || !chatId || !telegramUserId) {
      return NextResponse.json({ ok: true });
    }

    const stringId = String(telegramUserId);

    // 1. CAMADA L3 (ESTADO ATUAL)
    const { data: userProfile } = await supabase.from('users').select('nickname, current_context').eq('id', stringId).single();
    const authorName = userProfile?.nickname || userFirstName;
    const currentContextL3 = userProfile?.current_context || "ERRO_ID_NAO_LOCALIZADO";

    // 2. CAMADA HD (VETORIAL)
    const queryEmbedding = await generateEmbedding(messageText);
    let hdContext = "";
    if (queryEmbedding) {
      const { data: search }: any = await supabase.rpc('match_memories', { 
        query_embedding: queryEmbedding, 
        match_threshold: 0.4, 
        match_count: 2 
      });
      if (search && Array.isArray(search)) {
        hdContext = search.map((r: any) => `[Memória Antiga]: ${r.summary}`).join('\n');
      }
    }

    // 3. CAMADA RAM
    const { data: history } = await supabase.from('brain').select('content, category, metadata').eq('user_id', stringId).neq('category', 'noise').order('created_at', { ascending: false }).limit(15); 
    const ramMemory = history?.reverse().map((h: any) => {
      const aiReply = h.metadata?.ai_reply || "";
      const cleanAiReply = aiReply.replace(/\[.*?\]/g, '').trim();
      return `${authorName}: ${h.content}\nJarvis: ${cleanAiReply}`;
    }).join('\n') || "Iniciando protocolo de diálogo.";

    // 4. CAMADA CACHE (HORÁRIO REAL)
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const horaAtual = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getHours();

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | DATA/HORA: ${dataAtual}

[DADOS DE PERFIL (L3)]
${currentContextL3}

[CONTEXTO RECENTE (RAM)]
${ramMemory}

[HD]: ${hdContext}

MENSAGEM: "${messageText}"

MISSÃO:
1. SAUDAÇÃO: Use a hora atual (${horaAtual}h). Estilo Stark.
2. MULTI-SALVAMENTO: [SALVAR_EVENTO: Título | YYYY-MM-DD | alta/media/baixa | true/false]
3. GESTÃO DE DESCANSO: [DESATIVAR_ROTINA: YYYY-MM-DD]
4. AGENDA GOOGLE: [AGENDAR: Título | YYYY-MM-DDTHH:MM:SS | DuraçãoMinutos]
5. SIGILO: Comandos em colchetes nunca devem aparecer na resposta final.
6. CLASSIFICAÇÃO: Termine com [CLASSE: info] ou [CLASSE: noise].
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    // 5. PROCESSAMENTO E INTERCEPTORES
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // INTERCEPTOR: EVENTOS PROATIVOS
    const eventRegex = /\[?SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\]?/gi;
    const matches = Array.from(aiReply.matchAll(eventRegex));
    let savedEventsCount = 0;
    
    for (const m of matches) {
      if (m && m.length >= 5) {
        const fullMatch = m[0];
        const { error } = await supabase.from('events').insert([{
          user_id: stringId,
          title: m[1].trim(),
          event_date: m[2],
          priority: m[3].toLowerCase(),
          is_recurring: m[4].toLowerCase() === 'true',
          last_notified_year: new Date().getFullYear() - 1
        }]);
        
        if (!error) {
          aiReply = aiReply.replace(fullMatch, '').trim();
          savedEventsCount++;
        }
      }
    }

    if (savedEventsCount > 0) aiReply += `\n\n*(✔️ ${savedEventsCount} evento(s) registrado(s)).*`;

    // INTERCEPTOR: DESCANSO
    const interruptRegex = /\[?DESATIVAR_ROTINA:\s*(\d{4}-\d{2}-\d{2})\]?/i;
    const interruptMatch = aiReply.match(interruptRegex);
    if (interruptMatch && interruptMatch[1]) {
      await supabase.from('routine_exceptions').insert([{ user_id: stringId, exception_date: interruptMatch[1], type: 'pause_all' }]);
      aiReply = aiReply.replace(interruptMatch[0], '').trim() + "\n\n*(Descanso ativado).*";
    }

    // INTERCEPTOR: AGENDA GOOGLE (Com segurança de tipos)
    const updateRegex = /\[?ALTERAR_AGENDA:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i;
    const uMatch = aiReply.match(updateRegex);
    if (uMatch && uMatch.length >= 5) {
      const res = await updateGoogleEvent(uMatch[1].trim(), uMatch[2].trim(), uMatch[3].trim(), parseInt(uMatch[4]));
      aiReply = aiReply.replace(uMatch[0], '').trim() + `\n\n🗓️ **Ação Agenda:** ${res}`;
    }

    const scheduleRegex = /\[?AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i;
    const sMatch = aiReply.match(scheduleRegex);
    if (sMatch && sMatch.length >= 4) {
      const res = await createGoogleEvent(sMatch[1].trim(), sMatch[2].trim(), parseInt(sMatch[3]));
      aiReply = aiReply.replace(sMatch[0], '').trim() + `\n\n🗓️ **Ação Agenda:** ${res}`;
    }

    // 6. PERSISTÊNCIA
    await supabase.from('brain').insert([{ 
      content: messageText, 
      category, 
      user_id: stringId, 
      embedding: queryEmbedding, 
      metadata: { ai_reply: aiReply, user: authorName } 
    }]);

    await sendTelegram(chatId, aiReply);

    // 7. COMPACTAÇÃO
    const { count: currentBrainCount } = await supabase.from('brain').select('*', { count: 'exact', head: true }).eq('user_id', stringId).eq('category', 'info');
    if (currentBrainCount && currentBrainCount >= 20) {
      await compactMemory(stringId, authorName);
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}