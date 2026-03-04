import { NextResponse } from 'next/server';
import { supabase, sendTelegram, callOpenRouter } from '@/lib/jarvis';

export async function GET(req: Request) {
  // Proteção simples via Header (Configurar no Vercel Cron)
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const hoje = new Date();
    const seteDiasDepois = new Date();
    seteDiasDepois.setDate(hoje.getDate() + 7);

    // 1. Buscar eventos que acontecem nos próximos 7 dias
    // Nota: Para aniversários recorrentes, comparamos apenas Dia e Mês
    const { data: events } = await supabase
      .from('events')
      .select('*')
      .filter('last_notified_year', 'neq', hoje.getFullYear());

    if (!events || events.length === 0) return NextResponse.json({ ok: true, message: "Nenhum evento próximo." });

    for (const event of events) {
      const dataEvento = new Date(event.event_date);
      
      // Lógica de proximidade (Dia e Mês)
      if (dataEvento.getMonth() === seteDiasDepois.getMonth() && 
          dataEvento.getDate() === seteDiasDepois.getDate()) {
        
        // 2. Chamar o Jarvis para criar uma mensagem personalizada
        const prompt = `
          SISTEMA: JARVIS | NOTIFICAÇÃO PROATIVA
          USUÁRIO: Celio
          EVENTO: ${event.title} daqui a 7 dias.
          CONTEXTO ANTERIOR: ${JSON.stringify(event.metadata)}
          
          MISSÃO: Mande uma mensagem curta, elegante e proativa para o Celio. 
          Lembre-o do evento e sugira ajuda para o presente ou logística. 
          Mantenha o tom Stark (sarcasmo leve e eficiência).
        `;

        const jarvisMessage = await callOpenRouter(prompt);

        // 3. Disparar Telegram
        await sendTelegram(event.user_id, jarvisMessage);

        // 4. Marcar como notificado este ano
        await supabase
          .from('events')
          .update({ last_notified_year: hoje.getFullYear() })
          .eq('id', event.id);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro no Cron:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}