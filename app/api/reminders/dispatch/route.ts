import { NextRequest } from 'next/server';
import { dispatchPendingReminders } from '@/lib/reminders/dispatch';
import { dispatchRecurringReminders } from '@/lib/reminders/dispatchRecurring';

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  // Endpoint desativado — substituído pelo QStash
  return new Response('Gone', { status: 410 });

  /*
  // O bloco abaixo foi mantido para histórico estrutural, com a brecha 
  // do header corrigida caso o cron precise ser reativado no futuro.
  
  const auth = req.headers.get('authorization');
  const isVercelCron = req.headers.get('x-vercel-cron') === '1';

  // Exige o secret SEMPRE — mesmo quando vier da Vercel
  // x-vercel-cron sozinho não é suficiente (qualquer um pode forjar esse header)
  if (!isVercelCron || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    await Promise.all([
      dispatchPendingReminders(),
      dispatchRecurringReminders(),
    ]);
    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('[Dispatch Route] Erro:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
  */
}