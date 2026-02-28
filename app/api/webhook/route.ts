import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

// 1. Configuração do Supabase (Schema Jarvis)
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

// 2. Função para o Telegram (POST)
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageText = body.message?.text;
    const chatId = body.message?.chat?.id;

    if (!messageText) return NextResponse.json({ ok: true });

    // Inserção no banco
    const { error: dbError } = await supabase
      .from('brain')
      .insert([{
        content: messageText,
        category: 'Nota',
        project_tag: 'PQF',
        context_status: 'Execução'
      }]);

    if (dbError) throw new Error(dbError.message);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro no Webhook:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 3. Função para o Navegador (GET) - Evita o erro 405
export async function GET() {
  return NextResponse.json({ 
    status: "Online", 
    message: "O Jarvis está aguardando conexões via POST." 
  });
}