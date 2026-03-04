import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, generateEmbedding, sendTelegram, compactMemory } from '@/lib/jarvis';
import { createGoogleEvent, updateGoogleEvent } from '@/lib/google';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageText: string = body.message?.text || "";
    const chatId = body.message?.chat?.id;
    const telegramUserId = body.message?.from?.id;
    const userFirstName: string = body.message?.from?.first_name || "Usuário";
    const isBot: boolean = body.message?.from?.is_bot || false;

    if (isBot || !messageText || chatId == null || telegramUserId == null) {
      return NextResponse.json({ ok: true });
    }

    const stringId = String(telegramUserId);

    // 1. CAMADA L3 (Dossiê)
    const { data: userProfile } = await supabase.from('users').select('nickname, current_context').eq('id', stringId).single();
    const authorName = userProfile?.nickname || userFirstName;
    const currentContextL3 = userProfile?.current_context || "ERRO_ID_NAO_LOCALIZADO";

    // 2. CAMADA HD (Vetorial)
    const queryEmbedding = await generateEmbedding(messageText);
    let hdContext = "";
    if (queryEmbedding) {
      const { data: search }: { data: any[] | null } = await supabase.rpc('match_memories', { 
        query_embedding: queryEmbedding, 
        match_threshold: 0.4, 
        match_count: 2 
      });
      if (search && search.length > 0) {
        hdContext = search.map((r) => `[Memória Antiga]: ${r.summary}`).join('\n');
      }
    }

    // 3. CAMADA RAM
    const { data: history } = await supabase.from('brain').select('content, category, metadata').eq('user_id', stringId).neq('category', 'noise').order('created_at', { ascending: false }).limit(15); 
    const safeHistory = history || [];
    const ramMemory = safeHistory.reverse().map((h: any) => {
      const aiReply = h.metadata?.ai_reply || "";
      const cleanAiReply = aiReply.replace(/\[.*?\]/g, '').trim();
      return `${authorName}: ${h.content}\nJarvis: ${cleanAiReply}`;
    }).join('\n') || "Iniciando protocolo de diálogo.";

    // 4. CAMADA CACHE
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const horaAtual = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getHours();

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | DATA/HORA: ${dataAtual}

[DADOS DE PERFIL (L3)]
${currentContextL3}

[CONTEXTO RECENTE (RAM)]
${ramMemory}

MENSAGEM: "${messageText}"

MISSÃO:
1. SAUDAÇÃO: Use a hora atual (${horaAtual}h). Estilo Stark.
2. MULTI-SALVAMENTO: [SALVAR_EVENTO: Título | YYYY-MM-DD | alta/media/baixa | true/false]
3. GESTÃO DE DESCANSO: [DESATIVAR_ROTINA: YYYY-MM-DD]
4. SIGILO: Comandos em colchetes nunca devem aparecer na resposta final.
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // --- INTERCEPTORES (CORREÇÃO DE BUILD AQUI) ---
    
    // 1. Eventos Proativos
    const eventRegex = /\[?SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\]?/gi;
    const matches = Array.from(aiReply.matchAll(eventRegex)) as RegExpExecArray[]; // <-- FORCEI O TIPO AQUI
    let savedCount = 0;
    
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
          savedCount++;
        }
      }
    }

    if (savedCount > 0) aiReply += `\n\n*(✔️ ${savedCount} evento(s) registrado(s)).*`;

    // 2. Descanso
    const interruptRegex = /\[?DESATIVAR_ROTINA:\s*(\d{4}-\d{2}-\d{2})\]?/i;
    const interruptMatch = aiReply.match(interruptRegex) as RegExpMatchArray | null; // <-- FORCEI O TIPO AQUI
    if (interruptMatch && interruptMatch[1]) {
      await supabase.from('routine_exceptions').insert([{ user_id: stringId, exception_date: interruptMatch[1], type: 'pause_all' }]);
      aiReply = aiReply.replace(interruptMatch[0], '').trim() + "\n\n*(Descanso ativado).*";
    }

    // --- FIM DOS INTERCEPTORES ---

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