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

    // 1. Chamada ao OpenRouter (Protegida)
    const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        // ATENÇÃO: Usei OPENAI_API_KEY porque foi o nome que você usou no seu log de variáveis
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, 
        "Content-Type": "application/json",
        "HTTP-Referer": "https://jarvis-core-three.vercel.app",
      },
      body: JSON.stringify({
        "model": "google/gemini-2.0-flash-001",
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

    // Validação para evitar o erro "reading 0 of undefined"
    if (!aiData.choices || !aiData.choices[0]) {
      console.error("❌ Resposta inválida do OpenRouter:", JSON.stringify(aiData));
      throw new Error(aiData.error?.message || "Erro desconhecido na IA");
    }

    const replyText = aiData.choices[0].message.content;

    // 2. Registro no Supabase (Rigor de Dados)
    const { error: dbError } = await supabase.from('brain').insert([{
      content: messageText,
      category: 'Nota',
      project_tag: 'Jarvis_AI',
      metadata: { ai_reply: replyText }
    }]);

    if (dbError) console.error("❌ Erro Supabase:", dbError.message);

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
    console.error("🚨 Erro Crítico Jarvis:", error.message);
    // Retornamos 200 para o Telegram não ficar tentando reenviar em caso de erro de lógica
    return NextResponse.json({ error: error.message }, { status: 200 });
  }
}

// GET para confirmar que a rota está ativa
export async function GET() {
  return NextResponse.json({ status: "Jarvis AI Online" });
}