import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, sendTelegram } from '@/lib/jarvis';
import { getGoogleContext } from '@/lib/google';

export async function GET(req: Request) {
  try {
    // 1. SEGURANÇA HÍBRIDA (Aceita Header Vercel ou ?auth=Bearer...)
    const { searchParams } = new URL(req.url);
    const authParam = searchParams.get('auth');
    const authHeader = req.headers.get('authorization');
    const secret = `Bearer ${process.env.CRON_SECRET}`;

    if (authHeader !== secret && authParam !== secret) {
      return new Response('Unauthorized', { status: 401 });
    }

    const userId = process.env.MY_TELEGRAM_ID!; 
    const hoje = new Date();
    const hojeString = hoje.toISOString().split('T')[0];

    // 2. CHECAGEM DE EXCEÇÃO (INTERRUPTOR DE COMODIDADE)
    const { data: exception } = await supabase
      .from('routine_exceptions')
      .select('type')
      .eq('user_id', userId)
      .eq('exception_date', hojeString)
      .single();

    if (exception) {
      return NextResponse.json({ ok: true, message: "Briefing pausado hoje (Folga/Feriado)." });
    }

    // 3. CLIMA REAL (Londrina)
    const weatherRes = await fetch(`https://wttr.in/Londrina?format=%C+%t+%w`);
    const climaLondrina = await weatherRes.text();

    // 4. RECUPERAÇÃO DE CONTEXTO (HD) e AGENDA (GOOGLE)
    const { data: snapshot } = await supabase
      .from('memories')
      .select('summary')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const agenda = await getGoogleContext();

    // 5. PROMPT DE BRIEFING STARK
    const briefingPrompt = `
      Jarvis, briefing matinal para o Celio.
      [DATA]: ${hoje.toLocaleDateString('pt-BR')}
      [CONTEXTO HD]: ${snapshot?.summary || "Foco em pontualidade e ExpertFrotas."}
      [AGENDA]: ${agenda}
      [CLIMA]: ${climaLondrina}
      
      INSTRUÇÕES:
      - Estilo Tony Stark: Curto, inteligente, levemente sarcástico.
      - Não repita a hora.
      - Resuma os compromissos.
      - Dê uma dica de trajeto (moto) baseada no clima: ${climaLondrina}.
      - Lembre-o: Despertar 05h, Saída 06h20. Não se atrase.
    `;

    const aiReply = await callOpenRouter(briefingPrompt);

    // 6. ENVIO
    await sendTelegram(userId, aiReply);

    return NextResponse.json({ ok: true, weather: climaLondrina });

  } catch (error: any) {
    console.error("Erro no Cron Briefing:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}