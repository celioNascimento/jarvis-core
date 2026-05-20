// app/api/jobs/consolidate-memory/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { runNextConsolidationJob } from '@/lib/services/consolidation.service';

const CRON_SECRET = process.env.CRON_SECRET;

export async function POST(req: NextRequest) {
  // Segurança mínima — valida secret
  const secret = req.headers.get('x-cron-secret');
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runNextConsolidationJob();

    if (!result.processed) {
      return NextResponse.json({ ok: true, message: 'Fila vazia' });
    }

    return NextResponse.json({
      ok: true,
      jobId: result.jobId,
      userId: result.userId,
    });
  } catch (error: any) {
    console.error('[Jobs] consolidate-memory error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
