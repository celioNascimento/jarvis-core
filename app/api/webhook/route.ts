import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageText = body.message?.text;
    const chatId = body.message?.chat?.id;

    if (!messageText) return NextResponse.json({ ok: true });

    // 1. Chamada ao OpenRouter (Usando o Gemini do Google via Hub)
    const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        "model": "google/gemini-2.0-flash-001", // Aqui você escolhe a IA do Google
        "messages": [
          {
            "role": "system",
            "content": "Você é o Jarvis. Assistente focado em produtividade para um desenvolvedor com TDAH. Seja conciso, direto e use o Framework de 4 Etapas se for técnico."
          },
          { "role": "user", "content": messageText }
        ]
      })
    });

    const aiData = await aiResponse.json();
    const replyText = aiData.choices[0].message.content;

    // 2. Registro no Supabase (Mantendo o Rigor)
    await supabase.from('brain').insert([{
      content: messageText,
      category: 'Nota',
      project_tag: 'Jarvis_AI',
      metadata: { ai_reply: replyText }
    }]);

    // 3. Resposta no Telegram
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: replyText,
        parse_mode: 'Markdown'
      }),
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro no OpenRouter:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}