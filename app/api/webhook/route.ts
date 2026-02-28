import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: 'jarvis' } });

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageText = body.message?.text || "";
    const chatId = body.message?.chat?.id;

    if (!messageText) return NextResponse.json({ ok: true });

    // --- 1. LÓGICA DE COMANDO: /RESUMO ---
    if (messageText.startsWith('/resumo')) {
      const { data: logs } = await supabase
        .from('brain')
        .select('content, category, created_at')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()) // Últimas 24h
        .order('created_at', { ascending: true });

      const activityData = logs?.map(l => `[${l.category}] ${l.content}`).join('\n') || "Sem atividades hoje.";
      
      const summaryPrompt = `Abaixo estão minhas atividades das últimas 24h. 
      Resuma em 3 tópicos: 1. Progresso Técnico, 2. Ideias Estacionadas e 3. Próximo Passo Sugerido para o PQF ou ExpertFrotas.
      Atividades:\n${activityData}`;

      const aiSummary = await callOpenRouter(summaryPrompt);
      await sendTelegram(chatId, `📊 *Resumo das últimas 24h:*\n\n${aiSummary}`);
      return NextResponse.json({ ok: true });
    }

    // --- 2. MEMÓRIA DE CONTEXTO (CONVERSA) ---
    const { data: history } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('project_tag', 'Jarvis_AI')
      .order('created_at', { ascending: false })
      .limit(5);

    const memory = history?.reverse().map(h => `User: ${h.content}\nJarvis: ${h.metadata?.ai_reply}`).join('\n') || "";

    const fullPrompt = `Contexto recente:\n${memory}\n\nUsuário atual: ${messageText}`;
    const aiReply = await callOpenRouter(fullPrompt);

    // --- 3. REGISTRO E RESPOSTA ---
    await supabase.from('brain').insert([{
      content: messageText,
      category: 'Nota',
      project_tag: 'Jarvis_AI',
      metadata: { ai_reply: aiReply }
    }]);

    await sendTelegram(chatId, aiReply);
    return NextResponse.json({ ok: true });

  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ error: error.message }, { status: 200 });
  }
}

// Funções Auxiliares para manter o código limpo
async function callOpenRouter(prompt: string) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      "model": "google/gemini-2.0-flash-001",
      "messages": [{ "role": "system", "content": "Você é o Jarvis. Assistente focado em produtividade para um dev com TDAH. Use o Framework de 4 Etapas." }, { "role": "user", "content": prompt }]
    })
  });
  const data = await res.json();
  return data.choices[0].message.content;
}

async function sendTelegram(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}