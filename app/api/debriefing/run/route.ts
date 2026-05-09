// app/api/debriefing/run/route.ts
// Receptor do job diário de Debriefing (chamado pelo QStash via cron)
//
// NÃO chame esta rota diretamente em produção.
// O agendamento é feito via scripts/schedule-debriefing.ts (uma vez só).
//
// Para testar localmente: POST /api/debriefing/run com header x-debug: true

import { NextRequest, NextResponse } from 'next/server';
import { runDebriefing } from '@/lib/tools/executors/debriefing';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Validação mínima: bloqueia chamadas externas não autorizadas
  const signature = req.headers.get('upstash-signature');
  const isDebug   = req.headers.get('x-debug') === 'true';

  if (!signature && !isDebug) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await runDebriefing();
    return NextResponse.json({ ok: true, summary });
  } catch (err: any) {
    console.error('[Debriefing] Erro fatal:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}