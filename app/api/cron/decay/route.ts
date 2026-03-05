import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ============================================================
// CRON: MOTOR DE DECAY — Roda 1x por dia (03:00 AM)
// Atualiza relevâncias de todas as memórias no HD
// Implementa o algoritmo: relevância = base * e^(-λt) + reforço + emocional
// ============================================================

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // 1. Chama a função SQL de decay (definida na migration)
    const { error } = await supabase.rpc('update_all_relevances');
    if (error) throw new Error(`Decay SQL error: ${error.message}`);

    // 2. Conta memórias em cada estado
    const { data: stats } = await supabase
      .from('memories')
      .select('relevance_score');

    const total = stats?.length || 0;
    const ativas = stats?.filter(m => m.relevance_score > 0.3).length || 0;
    const fracas = stats?.filter(m => m.relevance_score <= 0.3 && m.relevance_score > 0.05).length || 0;
    const cinzas = stats?.filter(m => m.relevance_score <= 0.05).length || 0;

    console.log(`🧠 Decay aplicado: ${ativas} ativas | ${fracas} fracas | ${cinzas} cinzas | ${total} total`);

    return NextResponse.json({
      ok: true,
      stats: { total, ativas, fracas, cinzas }
    });

  } catch (error: any) {
    console.error("Erro no cron de decay:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
