// app/api/cron/briefing/route.ts
import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, sendTelegram } from '@/lib/jarvis';
import { getGoogleContext } from '@/lib/google';
import { getMicrosoftCalendarContext } from '@/lib/microsoft';
import { buildRecommendationsBlock } from '@/lib/extractor-jobs';

export const maxDuration = 25;

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const authParam  = searchParams.get('auth');
    const authHeader = req.headers.get('authorization');
    const secret     = `Bearer ${process.env.CRON_SECRET}`;

    if (authHeader !== secret && authParam !== secret) {
      return new Response('Unauthorized', { status: 401 });
    }

    const userId = process.env.MY_TELEGRAM_ID!;

    const [
      weatherData,
      googleAgenda,
      outlookAgenda,
      eventsResult,
      profileResult,
      recommendationsRaw,
    ] = await Promise.all([
      fetch(`https://wttr.in/Londrina?format=%C+%t`, {
        signal: AbortSignal.timeout(3000),
      })
        .then(r => r.text())
        .catch(() => 'Clima indisponível'),

      getGoogleContext().catch(() => null),
      getMicrosoftCalendarContext().catch(() => null),

      supabase
        .from('events')
        .select('title, event_date, priority, emotional_weight, notes')
        .eq('user_id', userId)
        .gte('event_date', new Date().toISOString().slice(0, 10))
        .lte('event_date', new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
        .order('event_date', { ascending: true })
        .limit(5)
        .then(r => r.data || []),

      supabase
        .from('users')
        .select('current_context, nickname, assistant_name')
        .eq('id', userId)
        .single()
        .then(r => r.data),

      buildRecommendationsBlock(userId, 'almoço jantar café lugar hoje').catch(() => ''),
    ]);

    const assistantName = profileResult?.assistant_name || 'Lev';
    const authorName    = profileResult?.nickname || 'Celio';
    const l3Context     = profileResult?.current_context || '';

    const today = new Date().toLocaleDateString('pt-BR', {
      weekday: 'long', day: 'numeric', month: 'long',
      timeZone: 'America/Sao_Paulo',
    });

    const agendaBlock = [
      googleAgenda  && !googleAgenda.includes('Erro')  ? `Google:\n${googleAgenda}`   : null,
      outlookAgenda && !outlookAgenda.includes('Erro') ? `Outlook:\n${outlookAgenda}` : null,
    ].filter(Boolean).join('\n\n') || 'Agenda limpa.';

    const eventsBlock = (eventsResult as any[]).length > 0
      ? (eventsResult as any[]).map((e: any) => {
          const daysUntil = Math.round(
            (new Date(e.event_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
          );
          const when = daysUntil === 0 ? 'HOJE'
                     : daysUntil === 1 ? 'amanhã'
                     : `em ${daysUntil} dias`;
          return `${e.title} — ${when}${e.notes ? ` (${e.notes})` : ''}`;
        }).join('\n')
      : 'Nada no radar nos próximos 30 dias.';

    const briefingPrompt = `Você é ${assistantName}, assistente pessoal de ${authorName}.
É ${today}. Gere o briefing matinal.

[AGENDA DE HOJE]
${agendaBlock}

[RADAR — PRÓXIMOS 30 DIAS]
${eventsBlock}

[CLIMA — LONDRINA]
${weatherData}

[RECOMENDAÇÕES DISPONÍVEIS]
${recommendationsRaw || 'Nenhuma cadastrada ainda.'}

[CONTEXTO DO USUÁRIO]
${l3Context ? l3Context.slice(0, 800) : 'Sem dossiê ainda.'}

FORMATO DA RESPOSTA — siga exatamente:
☀️ Bom dia, ${authorName}. [1 frase Stark — contextualizada no dia, irônica se couber]

🗓 HOJE
[agenda consolidada — se vazia, diz "Dia livre. Aproveita ou inventa um problema pra resolver."]

📡 NO RADAR
[eventos próximos — só os relevantes, com quantos dias faltam]

🌦 [clima em meia linha — sem drama]

💡 [1 recomendação de lugar ou atividade — contextualizada no dia da semana e clima. Só se houver recomendação disponível, senão omite esse bloco]

REGRAS:
- Tom: Tony Stark — inteligente, direto, levemente irônico. Nunca motivacional, nunca genérico.
- Máximo 20 linhas no total
- Horários fixos de ${authorName}: acorda 05h, sai 06h20 — mencione APENAS se houver conflito com a agenda
- NUNCA use "Anotado", "Registrado", "Com certeza!" ou qualquer frase de assistente genérico
- Se a agenda estiver vazia, começa com algo como "Dia sem compromissos. Raro. Aproveita."`;

    const aiReply = await Promise.race([
      callOpenRouter(briefingPrompt),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('IA Timeout')), 20000)
      ),
    ]) as string;

    await sendTelegram(userId, aiReply);

    return NextResponse.json({ ok: true });

  } catch (error: any) {
    console.error('[briefing] Erro:', error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
  }
}