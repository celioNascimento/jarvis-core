// app/api/reminders/dispatch/route.ts
import { dispatchPendingReminders } from '@/lib/reminders/dispatch';
import { dispatchRecurringReminders } from '@/lib/reminders/dispatchRecurring';

export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  await Promise.all([
    dispatchPendingReminders(),
    dispatchRecurringReminders(),
  ]);

  return new Response('OK');
}
