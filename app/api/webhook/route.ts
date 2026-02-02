import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const SEU_ID = '8595482774'; 

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const text = body.message?.text;
    const senderId = body.message?.chat?.id?.toString();

    if (!text) return NextResponse.json({ ok: true });

    // 1. Identifica o dono da nota (Corrigido aqui)
    const owner = senderId === SEU_ID ? 'Celio' : 'Desconhecido';

    // 2. Classifica a intenção
    let category = 'Nota';
    if (text.toLowerCase().startsWith('doc:')) category = 'Log_Tecnico';
    if (text.toLowerCase().startsWith('duvida:')) category = 'Dúvida';
    if (text.toLowerCase().startsWith('ideia:')) category = 'Ideia_Estacionada';

    // 3. Salva no Supabase
    const { error } = await supabase
      .from('brain')
      .insert([{ 
        content: text, 
        project_tag: senderId === SEU_ID ? 'PQF' : 'Geral', 
        category,
        metadata: { sender: owner, chat_id: senderId }
      }]);

    // 4. Resposta personalizada
    const reply = error ? "❌ Erro no sistema." : `✅ Registrado, ${owner}.`;
    
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: senderId, text: reply }),
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}