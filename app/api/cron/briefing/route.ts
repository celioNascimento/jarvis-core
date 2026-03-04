import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, sendTelegram } from '@/lib/jarvis';
import { getGoogleContext } from '@/lib/google';

export async function GET(req: Request) {
  try {
    // 1. SEGURANÇA: Verifica o token secreto da Vercel
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const userId = process.env.MY_TELEGRAM_ID!; 

    // 2. RECUPERAÇÃO DE CONTEXTO (HD)
    const { data: snapshot } = await supabase
      .from('memories')
      .select('summary')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // 3. RECUPERAÇÃO DE AGENDA (GOOGLE)
    const agenda = await getGoogleContext();

    // 4. CLIMA (Londrina) - No futuro podemos usar uma API, por agora fixamos a lógica
    const climaLondrina = "Ensolarado, máxima de 33°C e mínima de 18°C. Sem previsão de chuva.";

    // 5. PROMPT DE BRIEFING (O "Acorda, Jarvis!")
    const briefingPrompt = `
      Jarvis, prepare o briefing matinal para o Celio.
      
      [CONTEXTO DO HD]: ${snapshot?.summary || "Planejamento de nova rotina matinal com academia e foco em evitar atrasos."}
      [AGENDA DO DIA]: ${agenda}
      [CLIMA EM LONDRINA]: ${climaLondrina}
      
      INSTRUÇÕES:
      - Comece com um bom dia motivador.
      - Resuma os compromissos.
      - Dê uma dica baseada no clima (ex: calor de 33°C pede hidratação ou cuidado no trajeto de moto).
      - Lembre-o da meta de não se atrasar para o trabalho (8h) e gerenciar melhor o tempo na academia.
    `;

    const aiReply = await callOpenRouter(briefingPrompt);

    // 6. ENVIO PROATIVO
    await sendTelegram(userId, aiReply);

    return NextResponse.json({ ok: true });

  } catch (error: any) {
    console.error("Erro no Cron Briefing:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
