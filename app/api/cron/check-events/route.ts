import { NextResponse } from 'next/server';
import { supabase, sendTelegram, callOpenRouter } from '@/lib/jarvis';

export async function GET(req: Request) {
  // 1. SEGURANÇA
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // 2. CONSCIÊNCIA TEMPORAL (Londrina)
    const agora = new Date();
    const fusoLondrina = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const horaAtual = fusoLondrina.getHours();
    const anoAtual = fusoLondrina.getFullYear();

    // 3. BUSCAR USUÁRIOS DO HORÁRIO ATUAL
    const { data: users } = await supabase
      .from('users')
      .select('id, nickname, notification_hour')
      .eq('notification_hour', horaAtual);

    if (!users || users.length === 0) {
      return NextResponse.json({ ok: true, message: `Nenhum usuário configurado para as ${horaAtual}h.` });
    }

    for (const user of users) {
      // 4. BUSCAR EVENTOS NÃO NOTIFICADOS ESTE ANO PARA ESTE USUÁRIO
      const { data: events } = await supabase
        .from('events')
        .select('*')
        .eq('user_id', user.id)
        .neq('last_notified_year', anoAtual);

      if (!events) continue;

      for (const event of events) {
        const dataEv = new Date(event.event_date);
        const hoje = fusoLondrina;
        
        // Lógica: Hoje ou 7 dias antes
        const isHoje = dataEv.getUTCDate() === hoje.getUTCDate() && dataEv.getUTCMonth() === hoje.getUTCMonth();
        
        const seteDias = new Date(hoje);
        seteDias.setDate(hoje.getDate() + 7);
        const isPrevia = dataEv.getUTCDate() === seteDias.getUTCDate() && dataEv.getUTCMonth() === seteDias.getUTCMonth();

        if (isHoje || isPrevia) {
          // 5. PERSONALIDADE STARK NO DISPARO
          const statusTxt = isHoje ? "É HOJE" : "daqui a 7 dias";
          const prompt = `
            SISTEMA: JARVIS | USUÁRIO: ${user.nickname}
            NOTIFICAÇÃO: O evento "${event.title}" é ${statusTxt}.
            PRIORIDADE: ${event.priority}
            
            MISSÃO: Mande uma mensagem curta, elegante e sarcástica. 
            Se for prévia de 7 dias, sugira logística ou presente. 
            Se for hoje, seja direto e parabenize (se for aniversário).
            Não use cabeçalhos técnicos.
          `;

          const jarvisMessage = await callOpenRouter(prompt);

          // 6. DISPARAR E MARCAR
          await sendTelegram(user.id, jarvisMessage);
          await supabase.from('events').update({ last_notified_year: anoAtual }).eq('id', event.id);
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro no Cron de Eventos:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}