import { Receiver } from '@upstash/qstash';
import { NextRequest, NextResponse } from 'next/server';
import { extractAndSummarize } from '@/lib/extractor';
import { detectImplicitNegativeFeedback } from '@/lib/tools/executors/learning';
import { extractReminder } from '@/lib/chat/pipeline/extractors/reminders.extractor';
import { processStyleSignals } from '@/lib/chat/pipeline/style-learner';
import { insertBrainEntry } from '@/lib/services/brain.service';

export const maxDuration = 60;

type BackgroundPayload = {
  userId: string;
  nickname: string;
  authUserId: string;
  sessionId: string;
  message: string;
  reply: string;
  lastAssistantTurn: string | null;
  contexts: string[];
  reminder: boolean;
};

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get('upstash-signature');
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!signature || !currentSigningKey || !nextSigningKey) {
    return NextResponse.json({ error: 'Assinatura ausente' }, { status: 401 });
  }

  const receiver = new Receiver({ currentSigningKey, nextSigningKey });
  const valid = await receiver.verify({ signature, body }).catch(() => false);
  if (!valid) return NextResponse.json({ error: 'Assinatura inválida' }, { status: 401 });

  const payload = JSON.parse(body) as BackgroundPayload;
  const tasks: Promise<unknown>[] = [
    detectImplicitNegativeFeedback(payload.message, Number(payload.userId)),
    insertBrainEntry({
      userId: Number(payload.userId),
      sessionId: payload.sessionId,
      content: payload.message,
      lastAssistantTurn: payload.lastAssistantTurn,
      category: payload.message.length < 15 ? 'noise' : 'info',
      tags: payload.contexts,
      metadata: {
        role: 'user',
        model: 'google/gemini-2.5-flash',
        ai_reply: payload.reply,
        contexts: payload.contexts,
      },
    }),
    extractAndSummarize(payload.userId, payload.nickname, payload.message, payload.reply),
    processStyleSignals(payload.userId, payload.message),
  ];

  if (payload.reminder) {
    tasks.push(extractReminder(
      payload.userId,
      payload.authUserId,
      payload.message,
      new Date().toISOString(),
    ));
  }

  const results = await Promise.allSettled(tasks);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    console.error('[ChatBackground] Falhas:', failures.map((result) => result.status === 'rejected' ? result.reason : null));
  }

  return NextResponse.json({ ok: true, failedTasks: failures.length });
}
