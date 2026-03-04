import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, sendTelegram } from '@/lib/jarvis';
import { getGoogleContext } from '@/lib/google';

export async function GET(req: Request) {
  try {
    // 1. SEGURANÇA
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const userId = process.env.MY_TELEGRAM_ID!; 
    const hojeString = new Date().toISOString().split('T')[0]; // Pega apenas YYYY-MM-DD

    // 2. CHECAGEM DE EXCEÇÃO (O INTERRUPTOR DE COMODIDADE)
    const { data: exception } = await supabase
      .from('routine_exceptions')
      .select('type')
      .eq('user_id', userId)
      .eq('exception_date', hojeString)
      .single();

    // Se houver uma exceção registrada para hoje, o Cron aborta a missão silenciosamente
    if (exception) {
      console.log("Briefing pausado por solicitação do usuário (Feriado/Folga).");
      return NextResponse.json({ ok: true, message: "Briefing pausado hoje." });
    }

    // 3. RECUPERAÇÃO DE CONTEXTO (HD)
    const { data: snapshot } = await supabase
      .from('memories')
      .select('summary')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // 4. RECUPERAÇÃO DE AGENDA (GOOGLE)
    const agenda = await getGoogleContext();
    const climaLondrina = "Ensolarado, máxima de 33°C e mínima de 18°C. Sem previsão de chuva.";

    // 5. PROMPT DE BRIEFING (O "Acorda, Jarvis!")
    const briefingPrompt = `
      Jarvis, prepare o briefing matinal para o Celio.
      
      [CONTEXTO DO HD]: ${snapshot?.summary || "Planejamento de rotina com foco em pontualidade."}
      [AGENDA DO DIA]: ${agenda}
      [CLIMA EM LONDRINA]: ${climaLondrina}
      
      INSTRUÇÕES:
      - Comece com um bom dia motivador no estilo Stark.
      - Resuma os compromissos.
      - Dê uma dica baseada no clima (ex: calor pede hidratação ou cuidado na moto).
      - Lembre-o da meta de não se atrasar para o trabalho e gerenciar o treino (05h despertar, 06h20 saída).
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