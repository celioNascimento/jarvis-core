// app/api/debriefing/decay/route.ts
// Receptor do job semanal de Decaimento (chamado pelo QStash via cron)
//
// NÃO chame esta rota diretamente em produção.
// O agendamento é feito via scripts/schedule-decay.ts (uma vez só).
//
// Para testar localmente:
//   Invoke-WebRequest -Uri "https://seu-app.vercel.app/api/debriefing/decay" -Method POST -Headers @{"x-debug"="true"} -ContentType "application/json" -Body "{}"

import { NextRequest, NextResponse } from 'next/server';
import { runDecay } from '@/lib/tools/executors/decay';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const signature = req.headers.get('upstash-signature');
  const isDebug   = req.headers.get('x-debug') === 'true';

  if (!signature && !isDebug) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await runDecay();
    return NextResponse.json({ ok: true, summary });
  } catch (err: any) {
    console.error('[Decay] Erro fatal:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}