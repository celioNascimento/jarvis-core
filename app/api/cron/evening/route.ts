// app/api/cron/evening/route.ts
import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, sendTelegram } from '@/lib/jarvis';

export const maxDuration = 25;

export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { data: users } = await supabase
      .from('users')
      .select('id, nickname, assistant_name, telegram_chat_id, timezone')
      .not('telegram_chat_id', 'is', null);

    if (!users?.length) return NextResponse.json({ ok: true, sent: 0 });

    let sent = 0;

    for (const user of users) {
      try {
        const assistantName = user.assistant_name || 'Lev';
        const name          = user.nickname || 'você';
        const today         = new Date().toISOString().slice(0, 10);

        // Evita perguntar duas vezes no mesmo dia
        const { data: existing } = await supabase
          .from('diary')
          .select('id')
          .eq('user_id', String(user.id))
          .eq('date', today)
          .eq('period', 'evening')
          .maybeSingle();

        if (existing) continue;

        // Metas ativas para personalizar a mensagem
        const { data: goals } = await supabase
          .from('goals')
          .select('title, progress')
          .eq('user_id', String(user.id))
          .eq('status', 'active')
          .limit(3);

        const goalsContext = goals?.length
          ? `Metas ativas: ${goals.map((g: any) => `${g.title} (${g.progress}%)`).join(', ')}.`
          : '';

        const prompt = `Você é ${assistantName}, assistente pessoal de ${name}.
É fim do dia. Mande uma mensagem curta e humana pedindo a reflexão do dia.
${goalsContext}

REGRAS:
- Máximo 3 linhas
- Tom: amigo próximo, não coach motivacional
- Pergunte sobre o dia — como foi, o que foi bom, o que pesou
- Se há metas, pode tocar em uma de forma leve e natural — nunca cobrando
- NUNCA use "Anotado!", "Registrado!", frases corporativas ou emojis em excesso
- Termine com uma pergunta aberta simples`;

        const mensagem = await callOpenRouter(prompt);
        await sendTelegram(user.telegram_chat_id, mensagem);
        sent++;

        console.log(`[evening] Enviado para user ${user.id}`);
      } catch (e) {
        console.error(`[evening] Erro no user ${user.id}:`, e);
      }
    }

    return NextResponse.json({ ok: true, sent });
  } catch (e: any) {
    console.error('[evening] Erro geral:', e.message);
    return NextResponse.json({ ok: false, error: e.message }, { status: 200 });
  }
}