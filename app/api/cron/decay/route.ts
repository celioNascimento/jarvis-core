import { NextResponse } from 'next/server';
import { supabase, callOpenRouter } from '@/lib/jarvis';

// ============================================================
// CRON: DECAY v1.2 — Roda diariamente às 03:00
// Atualiza relevâncias de memories + events
// Arquiva memórias fracas como cinzas com resumo da IA
// ============================================================

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  const { searchParams } = new URL(req.url);
  const authParam = searchParams.get('auth');

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && authParam !== process.env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // 1. Roda o decay completo (memories + events + arquiva cinzas)
    const { error } = await supabase.rpc('update_all_relevances');
    if (error) throw new Error(`Decay SQL error: ${error.message}`);

    // 2. Busca cinzas recém-criadas sem resumo inteligente (ash_summary bruto)
    //    e melhora com IA para ficar mais natural
    const { data: rawAshes } = await supabase
      .from('memory_ashes')
      .select('id, ash_summary, original_memory_id')
      .not('ash_summary', 'like', '[AI]%')  // ainda não processadas pela IA
      .limit(10);

    let ashesProcessed = 0;
    if (rawAshes && rawAshes.length > 0) {
      for (const ash of rawAshes) {
        try {
          // Busca o summary completo da memória original se ainda existir
          let originalSummary = ash.ash_summary;
          if (ash.original_memory_id) {
            const { data: orig } = await supabase
              .from('memories')
              .select('summary')
              .eq('id', ash.original_memory_id)
              .single();
            if (orig) originalSummary = orig.summary;
          }

          const prompt = `
Você é o Arquivista do Jarvis. Comprima esta memória em UMA ÚNICA LINHA de no máximo 15 palavras.
Preserve: datas, nomes próprios, projetos, decisões importantes.
Formato: "~[período]: [fato essencial comprimido]"
Exemplo: "~Jan/2026: iniciou projeto ExpertFrotas, foco em MVP de frotas"

MEMÓRIA ORIGINAL:
${originalSummary.substring(0, 1000)}

Retorne APENAS a linha comprimida, sem explicações.
          `;

          const compressed = await callOpenRouter(prompt);
          const cleanCompressed = compressed.replace(/\n/g, ' ').trim();

          await supabase
            .from('memory_ashes')
            .update({ ash_summary: `[AI] ${cleanCompressed}` })
            .eq('id', ash.id);

          ashesProcessed++;
          await new Promise(r => setTimeout(r, 300)); // rate limit
        } catch (e) {
          console.error(`Erro ao comprimir cinza ${ash.id}:`, e);
        }
      }
    }

    // 3. Estatísticas
    const [memoriesStats, eventsStats, ashesStats] = await Promise.all([
      supabase.from('memories').select('relevance_score'),
      supabase.from('events').select('relevance_score, decay_type'),
      supabase.from('memory_ashes').select('id')
    ]);

    const mStats = memoriesStats.data || [];
    const eStats = eventsStats.data || [];

    const stats = {
      memories: {
        ativas:  mStats.filter(m => (m.relevance_score || 0) > 0.3).length,
        fracas:  mStats.filter(m => (m.relevance_score || 0) <= 0.3 && (m.relevance_score || 0) > 0.05).length,
        cinzas:  mStats.filter(m => (m.relevance_score || 0) <= 0.05).length,
      },
      events: {
        urgentes: eStats.filter(e => (e.relevance_score || 0) >= 0.7).length,
        radar:    eStats.filter(e => (e.relevance_score || 0) >= 0.3 && (e.relevance_score || 0) < 0.7).length,
        dormindo: eStats.filter(e => (e.relevance_score || 0) < 0.3).length,
      },
      ashes: {
        total: ashesStats.data?.length || 0,
        processadas_hoje: ashesProcessed
      }
    };

    return NextResponse.json({ ok: true, stats });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
