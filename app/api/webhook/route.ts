import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, generateEmbedding, sendTelegram, compactMemory } from '@/lib/jarvis';
import { createGoogleEvent, updateGoogleEvent } from '@/lib/google';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageText: string = body.message?.text || "";
    const chatId: number = body.message?.chat?.id;
    const telegramUserId: number = body.message?.from?.id;
    const userFirstName: string = body.message?.from?.first_name || "Usuário";
    const isBot: boolean = body.message?.from?.is_bot || false;

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
      const { data: search }: any = await supabase.rpc('match_memories', { query_embedding: queryEmbedding, match_threshold: 0.4, match_count: 2 });
      if (search && search.length > 0) {
        hdContext = search.map((r: any) => `[Memória Antiga]: ${r.summary}`).join('\n');
      }
    }

    // 3. CAMADA RAM
    const { data: history } = await supabase.from('brain').select('content, category, metadata').eq('user_id', stringId).neq('category', 'noise').order('created_at', { ascending: false }).limit(15); 
    const ramMemory = history?.reverse().map((h: any) => {
      const cleanAiReply = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
      return `${authorName}: ${h.content}\nJarvis: ${cleanAiReply}`;
    }).join('\n') || "Iniciando protocolo de diálogo.";

    // 4. CAMADA CACHE
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
1. SAUDAÇÃO: Use a hora atual (${horaAtual}h) para saudar. Estilo Stark.
2. MULTI-SALVAMENTO: [SALVAR_EVENTO: Título | YYYY-MM-DD | alta/media/baixa | true/false]
3. GESTÃO DE DESCANSO: [DESATIVAR_ROTINA: YYYY-MM-DD]
4. AGENDA GOOGLE: [AGENDAR: Título | YYYY-MM-DDTHH:MM:SS | DuraçãoMinutos]
5. SIGILO ABSOLUTO: Comandos em colchetes nunca devem aparecer na resposta final.
6. CLASSIFICAÇÃO: Termine com [CLASSE: info] ou [CLASSE: noise].
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // INTERCEPTOR: EVENTOS PROATIVOS
    const eventRegex = /\[?SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\]?/gi;
    const matches = Array.from(aiReply.matchAll(eventRegex));
    let count = 0;
    
    for (const m of matches) {
      if (m && m.length >= 5) {
        const fullMatch = m[0];
        const title = m[1].trim();
        const date = m[2];
        const priority = m[3].toLowerCase();
        const recurring = m[4].toLowerCase() === 'true';

        const { error } = await supabase.from('events').insert([{
          user_id: stringId,
          title,
          event_date: date,
          priority,
          is_recurring: recurring,
          last_notified_year: new Date().getFullYear() - 1
        }]);
        
        if (!error) {
          aiReply = aiReply.replace(fullMatch, '').trim();
          count++;
        }
      }
    }

    if (count > 0) aiReply += `\n\n*(✔️ ${count} evento(s) registrado(s)).*`;

    // INTERCEPTOR: DESCANSO
    const interruptRegex = /\[?DESATIVAR_ROTINA:\s*(\d{4}-\d{2}-\d{2})\]?/i;
    const interruptMatch = aiReply.match(interruptRegex);
    if (interruptMatch && interruptMatch[1]) {
      await supabase.from('routine_exceptions').insert([{ user_id: stringId, exception_date: interruptMatch[1], type: 'pause_all' }]);
      aiReply = aiReply.replace(interruptMatch[0], '').trim() + "\n\n*(Descanso ativado).*";
    }

    // INTERCEPTOR: AGENDA GOOGLE
    const updateRegex = /\[?ALTERAR_AGENDA:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i;
    const updateMatch = aiReply.match(updateRegex);
    if (updateMatch && updateMatch.length >= 5) {
      const result = await updateGoogleEvent(updateMatch[1].trim(), updateMatch[2].trim(), updateMatch[3].trim(), parseInt(updateMatch[4]));
      aiReply = aiReply.replace(updateMatch[0], '').trim() + `\n\n🗓️ **Ação Agenda:** ${result}`;
    }

    const scheduleRegex = /\[?AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i;
    const scheduleMatch = aiReply.match(scheduleRegex);
    if (scheduleMatch && scheduleMatch.length >= 4) {
      const result = await createGoogleEvent(scheduleMatch[1].trim(), scheduleMatch[2].trim(), parseInt(scheduleMatch[3]));
      aiReply = aiReply.replace(scheduleMatch[0], '').trim() + `\n\n🗓️ **Ação Agenda:** ${result}`;
    }

    // 6. PERSISTÊNCIA
    await supabase.from('brain').insert([{ content: messageText, category, user_id: stringId, embedding: queryEmbedding, metadata: { ai_reply: aiReply, user: authorName } }]);
    await sendTelegram(chatId, aiReply);

    // 7. COMPACTAÇÃO
    const { count: brainCount } = await supabase.from('brain').select('*', { count: 'exact', head: true }).eq('user_id', stringId).eq('category', 'info');
    if (brainCount && brainCount >= 20) {
      await compactMemory(stringId, authorName);
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}