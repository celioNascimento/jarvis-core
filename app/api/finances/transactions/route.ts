// app/api/finances/transactions/route.ts
// CRUD de transações — GET lista, POST cria

import { NextRequest, NextResponse } from 'next/server';
import {
  createTransaction,
  getTransactions,
  updateTransactionStatus,
  getPeriodDates,
} from '@/lib/finances/db';
import type { CreateTransactionPayload, TransactionType } from '@/lib/finances/types';
import { resolveUser } from '@/lib/finances/auth';
import { supabase } from '@/lib/jarvis';




export async function GET(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const period = (searchParams.get('period') || 'month') as any;
    const type = searchParams.get('type') as TransactionType | null;
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const status = searchParams.get('status') || undefined;

    const { start, end } = getPeriodDates(period);

    const transactions = await getTransactions(user.jarvisUserId, {
      start,
      end,
      type: type || undefined,
      status,
      limit,
      offset,
    });

    return NextResponse.json({ ok: true, data: transactions, count: transactions.length });
  } catch (e: any) {
    console.error('[API] GET /finances/transactions:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const body: CreateTransactionPayload = await req.json();
    if (!body.amount || !body.type)
      return NextResponse.json({ error: 'amount e type são obrigatórios.' }, { status: 400 });

    const tx = await createTransaction(user.authUserId, user.jarvisUserId, body);
    return NextResponse.json({ ok: true, data: tx }, { status: 201 });
  } catch (e: any) {
    console.error('[API] POST /finances/transactions:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
