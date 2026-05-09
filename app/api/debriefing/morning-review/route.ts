// app/api/debriefing/morning-review/route.ts
// Receptor do job diário de Revisão Matinal (chamado pelo QStash via cron)
//
// NÃO chame esta rota diretamente em produção.
// O agendamento é feito via scripts/schedule-morning-review.ts (uma vez só).
//
// Para testar:
//   Invoke-WebRequest -Uri "https://jarvis-core-three.vercel.app/api/debriefing/morning-review" -Method POST -Headers @{"x-debug"="true"} -ContentType "application/json" -Body "{}"

import { NextRequest, NextResponse } from 'next/server';
import { runMorningReview } from '@/lib/tools/executors/morning-review';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const signature = req.headers.get('upstash-signature');
  const isDebug   = req.headers.get('x-debug') === 'true';

  if (!signature && !isDebug) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await runMorningReview();
    return NextResponse.json({ ok: true, summary });
  } catch (err: any) {
    console.error('[MorningReview] Erro fatal:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}