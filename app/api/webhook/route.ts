import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, generateEmbedding, sendTelegram } from '@/lib/jarvis';
import { updateGoogleEvent, createGoogleEvent } from '@/lib/google';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageText = body.message?.text || "";
    const chatId = body.message?.chat?.id;
    const telegramUserId = body.message?.from?.id;
    const userFirstName = body.message?.from?.first_name || "Usuário";

    // 1. TRAVA DE SEGURANÇA E ECO
    if (!messageText || body.message?.from?.is_bot) return NextResponse.json({ ok: true });

    // 2. RECUPERAÇÃO DE PERFIL E SNAPSHOT (HD)
    const { data: userProfile } = await supabase.from('users').select('nickname').eq('id', telegramUserId).single();
    const authorName = userProfile?.nickname || userFirstName;

    const { data: snapshot } = await supabase
      .from('memories')
      .select('summary')
      .eq('user_id', telegramUserId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // 3. RECUPERAÇÃO DA RAM (CONVERSA RECENTE)
    const { data: history } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('user_id', telegramUserId)
      .neq('category', 'noise')
      .order('created_at', { ascending: false })
      .limit(10);

    const ramMemory = history?.reverse().map(h => {
      const cleanAiReply = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
      return `${authorName}: ${h.content}\nJarvis: ${cleanAiReply}`;
    }).join('\n') || "Iniciando nova conversa.";

    // 4. MOTOR DE IA (PROMPT UNIFICADO)
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | DATA: ${dataAtual}

[SNAPSHOT DE CONTEXTO (HD)]
${snapshot?.summary || "Nenhum snapshot de longo prazo disponível."}

[HISTÓRICO RECENTE (RAM)]
${ramMemory}

[MENSAGEM ATUAL]
"${messageText}"

DIRETRIZES:
1. Responda com base no Snapshot e no Histórico para manter a continuidade.
2. NUNCA agende nada sem comando explícito (ex: "agende", "marque").
3. OBRIGATÓRIO: Classifique a mensagem no final: [CLASSE: noise] para saudações ou [CLASSE: info] para dados importantes.
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    // 5. TRATAMENTO DE CLASSIFICAÇÃO E AGENDA
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // Interceptador de Agendamento
    const scheduleRegex = /\[AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]/i;
    const scheduleMatch = aiReply.match(scheduleRegex);
    if (scheduleMatch) {
      const result = await createGoogleEvent(scheduleMatch[1], scheduleMatch[2], parseInt(scheduleMatch[3]));
      aiReply += `\n\n🗓️ **Ação:** ${result}`;
    }

    // 6. PERSISTÊNCIA E RESPOSTA
    const queryEmbedding = await generateEmbedding(messageText);
    
    await supabase.from('brain').insert([{
      content: messageText,
      category: category,
      user_id: telegramUserId,
      embedding: queryEmbedding,
      metadata: { ai_reply: aiReply, user: authorName }
    }]);

    await sendTelegram(chatId, aiReply);

    return NextResponse.json({ ok: true });

  } catch (error: any) {
    console.error("Erro Webhook:", error.message);
    return NextResponse.json({ ok: true });
  }
}
