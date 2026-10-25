// app/api/lev/warmup/route.ts
// Acorda a Modal e informa o estado. O app chama em loop (long-poll) até 'ready'.
// Só 'warming' deve segurar o app; ready / not_configured / auth_error / error liberam o envio
// (o chat cai no fallback sozinho se a Modal estiver indisponível).

import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { supabase } from '@/lib/jarvis';
import { getLevStatus } from '@/lib/chat/lev-gateway';

export const maxDuration = 40;
export const dynamic = 'force-dynamic';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Um cold start usa no máximo ~10 chamadas; 40 por janela de 10 min cobre o uso normal
// e impede um loop de manter a GPU ligada.
const MAX_CALLS_PER_WINDOW = 40;
const WINDOW_SECONDS = 600;

async function isRateLimited(userId: number): Promise<boolean> {
  try {
    const key = `lev_warmup:${userId}:${Math.floor(Date.now() / (WINDOW_SECONDS * 1000))}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SECONDS);
    return count > MAX_CALLS_PER_WINDOW;
  } catch {
    return false; // Redis é opcional: se falhar, não bloqueia o warm-up.
  }
}

export async function POST(req: NextRequest) {
  let userEmail = '';
  try {
    const body = await req.json();
    userEmail = typeof body?.userEmail === 'string' ? body.userEmail.trim() : '';
  } catch {
    return NextResponse.json({ error: 'Body inválido' }, { status: 400 });
  }

  if (!userEmail) {
    return NextResponse.json({ error: 'Auth failed' }, { status: 401 });
  }

  // Mesmo padrão de autenticação do chat (buildRequestContext).
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('email', userEmail)
    .single();

  if (!user) {
    return NextResponse.json({ error: 'Auth failed' }, { status: 401 });
  }

  if (await isRateLimited(user.id)) {
    return NextResponse.json({ error: 'Muitas tentativas' }, { status: 429 });
  }

  const status = await getLevStatus();
  return NextResponse.json({ ok: true, status });
}
