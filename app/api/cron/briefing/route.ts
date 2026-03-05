import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, sendTelegram } from '@/lib/jarvis';
import { getGoogleContext } from '@/lib/google';

export const maxDuration = 10; // Força o limite da Vercel para 10s

export async function GET(req: Request) {
  try {
    // 1. SEGURANÇA HÍBRIDA
    const { searchParams } = new URL(req.url);
    const authParam = searchParams.get('auth');
    const authHeader = req.headers.get('authorization');
    const secret = `Bearer ${process.env.CRON_SECRET}`;

    if (authHeader !== secret && authParam !== secret) {
      return new Response('Unauthorized', { status: 401 });
    }

    const userId = process.env.MY_TELEGRAM_ID!;
    
    // 2. BUSCA DE DADOS EM PARALELO (Mais rápido que um por um)
    const [weatherData, googleAgenda, snapshot] = await Promise.all([
      fetch(`https://wttr.in/Londrina?format=%C+%t`, { signal: AbortSignal.timeout(3000) }) // 3s max
        .then(res => res.text())
        .catch(() => "Clima indisponível"),
      
      getGoogleContext().catch(() => "Agenda indisponível no momento"),
      
      supabase
        .from('memories')
        .select('summary')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()
        .then(res => res.data?.summary || "Sem contexto prévio.")
    ]);

    // 3. PROMPT STARK (ESTRUTURADO PARA VELOCIDADE)
    const briefingPrompt = `
      Jarvis, briefing matinal para o Celio.
      [CONTEXTO]: ${snapshot}
      [AGENDA]: ${googleAgenda}
      [CLIMA]: ${weatherData}
      
      MISSÃO: Estilo Tony Stark. Curto e direto. 
      Resuma o dia e lembre-o: Acordar 05h, Sair 06h20.
    `;

    // 4. CHAMADA IA COM TIMEOUT
    const aiReply = await Promise.race([
      callOpenRouter(briefingPrompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('IA Timeout')), 6000))
    ]) as string;

    // 5. ENVIO E RESPOSTA IMEDIATA
    await sendTelegram(userId, aiReply);

    return NextResponse.json({ ok: true, weather: weatherData });

  } catch (error: any) {
    console.error("Erro Cron:", error.message);
    // Se der erro, pelo menos retorna algo para a Vercel não ficar "pensando"
    return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
  }
}