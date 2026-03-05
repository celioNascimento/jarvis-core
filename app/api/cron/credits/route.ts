import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// CRON: CRÉDITOS MENSAIS — Roda todo dia 1 às 00:00
// Inicializa os créditos do mês para todos os usuários ativos
// ============================================================

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  const { searchParams } = new URL(req.url);
  const authParam = searchParams.get('auth');

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && authParam !== process.env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Chama a função SQL que inicializa créditos para todos os usuários
    const { error } = await supabase.rpc('init_monthly_credits');
    if (error) throw new Error(`Erro SQL: ${error.message}`);

    // Estatísticas do mês atual
    const currentMonth = new Date().getMonth() + 1;
    const currentYear  = new Date().getFullYear();

    const { data: stats } = await supabase
      .from('usage_credits')
      .select('model_tier, limit_total')
      .eq('period_month', currentMonth)
      .eq('period_year', currentYear);

    const summary = {
      flash:  stats?.filter(s => s.model_tier === 'flash').length  || 0,
      haiku:  stats?.filter(s => s.model_tier === 'haiku').length  || 0,
      sonnet: stats?.filter(s => s.model_tier === 'sonnet').length || 0,
    };

    console.log(`💳 Créditos ${currentMonth}/${currentYear} inicializados:`, summary);

    return NextResponse.json({ ok: true, period: `${currentMonth}/${currentYear}`, summary });

  } catch (error: any) {
    console.error("Erro no cron de créditos:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
