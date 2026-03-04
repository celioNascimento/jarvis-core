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

    // 2. CAMADA HD (VETORIAL)
    const queryEmbedding = await generateEmbedding(messageText);
    let hdContext = "";
    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', { query_embedding: queryEmbedding, match_threshold: 0.4, match_count: 2 });
      if (search?.length) hdContext = search.map((r: any) => `[Memória Antiga]: ${r.summary}`).join('\n');
    }

    // 3. CAMADA RAM
    const { data: history } = await supabase.from('brain').select('content, category, metadata').eq('user_id', stringId).neq('category', 'noise').order('created_at', { ascending: false }).limit(15); 
    const ramMemory = history?.reverse().map(h => {
      const cleanAiReply = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
      return `${authorName}: ${h.content}\nJarvis: ${cleanAiReply}`;
    }).join('\n') || "Iniciando protocolo de diálogo.";

    // 4. CAMADA CACHE (MOTOR DE INTELIGÊNCIA)
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const horaAtual = new Date().getHours();

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | DATA/HORA: ${dataAtual}

[DADOS DE PERFIL (L3)]
${currentContextL3}

[CONTEXTO RECENTE (RAM)]
${ramMemory}

MENSAGEM: "${messageText}"

MISSÃO:
1. SAUDAÇÃO: Use a hora atual (${horaAtual}h) para saudar corretamente. Seja amigável e Stark.
2. MULTI-SALVAMENTO: Se houver várias datas, gere UM comando por data no formato:
   [SALVAR_EVENTO: Título | YYYY-MM-DD | alta/media/baixa | true/false]
3. SIGILO: NUNCA exiba os comandos em colchetes para o usuário. Eles devem ficar no fim da sua resposta para o sistema processar e deletar.
4. RIGOR: Mantenha Framework 4 Etapas e Estacionamento de Ideias.
5. CLASSIFICAÇÃO: Termine com [CLASSE: info] ou [CLASSE: noise].
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // INTERCEPTOR DE EVENTOS (LOOP ROBUSTO)
    const eventRegex = /\[SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\]/gi;
    let match;
    let count = 0;
    
    // Usamos matchAll para pegar todos os eventos de uma vez
    const matches = Array.from(aiReply.matchAll(eventRegex));
    
    for (const m of matches) {
      const [fullMatch, title, date, priority, recurring] = m;
      const { error } = await supabase.from('events').insert([{
        user_id: stringId,
        title: title.trim(),
        event_date: date,
        priority: priority.toLowerCase(),
        is_recurring: recurring.toLowerCase() === 'true',
        last_notified_year: new Date().getFullYear() - 1
      }]);
      
      if (!error) {
        aiReply = aiReply.replace(fullMatch, '').trim();
        count++;
      } else {
        console.error("Erro ao salvar no schema jarvis:", error.message);
      }
    }

    if (count > 0) aiReply += `\n\n*(✔️ ${count} evento(s) devidamente registrado(s) no schema jarvis).*`;

    // (Interceptors de Descanso e Agenda mantidos...)
    const interruptRegex = /\[DESATIVAR_ROTINA:\s*(\d{4}-\d{2}-\d{2})\]/i;
    const interruptMatch = aiReply.match(interruptRegex);
    if (interruptMatch) {
      await supabase.from('routine_exceptions').insert([{ user_id: stringId, exception_date: interruptMatch[1], type: 'pause_all' }]);
      aiReply = aiReply.replace(interruptMatch[0], '').trim() + "\n\n*(Descanso ativado).*";
    }

    // 6. PERSISTÊNCIA
    await supabase.from('brain').insert([{ content: messageText, category, user_id: stringId, embedding: queryEmbedding, metadata: { ai_reply: aiReply, user: authorName } }]);
    await sendTelegram(chatId, aiReply);

    // 7. COMPACTAÇÃO
    const { count: brainCount } = await supabase.from('brain').select('*', { count: 'exact', head: true }).eq('user_id', stringId).eq('category', 'info');
    if (brainCount && brainCount >= 20) compactMemory(stringId, authorName);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}