// app/api/jobs-processor/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase, generateEmbedding, compactMemory } from '@/lib/jarvis';
import { Redis } from '@upstash/redis';
import { runUnifiedExtractor } from '@/lib/chat/unified-extractor';
import { extractProfileFromConversation } from '@/lib/chat/profile-extractor';
import { promotePatternToPrinciple } from '@/lib/chat/pattern-promoter';
import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway'; 
import { Receiver } from "@upstash/qstash";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
});

async function runIdempotentTask(taskName: string, msg_id: string, taskFn: () => Promise<any>) {
  const taskKey = `task_done:${taskName}:${msg_id}`;
  if (await redis.get(taskKey)) return { status: 'skipped' };
  await taskFn();
  await redis.set(taskKey, 'true', { ex: 604800 });
  return { status: 'success' };
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get("upstash-signature");
  const body = await req.text();

  try {
    await receiver.verify({
      signature: signature!,
      body: body,
      url: `${process.env.NEXT_PUBLIC_APP_URL}/api/jobs-processor`,
    });
  } catch (err) {
    return NextResponse.json({ error: "Assinatura inválida" }, { status: 401 });
  }

  const payload = JSON.parse(body);
  const { msg_id, userId, message, reply, contexts, emotional, authorName, assistantName, sessionId, modelRoute } = payload;
  const globalLockKey = `job_lock:${msg_id}`;
  
  if (!await redis.set(globalLockKey, 'processing', { nx: true, ex: 60 })) {
    return NextResponse.json({ ok: true, status: 'concurrent_skipped' });
  }

  try {
    // 1. SELF-HEALING (State, not flags)
    const { data: existingBrain } = await supabase
      .from('brain')
      .select('id')
      .eq('metadata->>msg_id', msg_id)
      .maybeSingle();

    if (!existingBrain) {
      const embedding = await generateEmbedding(message);
      await supabase.from('brain').insert([{
        content: message, 
        user_id: userId, 
        embedding,
        category: 'info',
        metadata: { ai_reply: reply, msg_id, recovered: true }
      }]);
    }

    const tasks = [
      runIdempotentTask('unified_extractor', msg_id, () => runUnifiedExtractor(userId, authorName, message, reply)),
      runIdempotentTask('profile_extractor', msg_id, () => extractProfileFromConversation(parseInt(userId), message, reply))
    ];

    // CRITIC (30%) - PROMPT RESTAURADO
    if (Math.random() <= 0.30) {
      tasks.push(runIdempotentTask('critic', msg_id, async () => {
        const criticPrompt = `Você é um avaliador interno de qualidade de um assistente de IA pessoal chamado ${assistantName}.
Avalie a resposta do assistente abaixo em 3 dimensões (0.0 a 1.0 cada):
MENSAGEM DO USUÁRIO: "${message.slice(0, 300)}"
RESPOSTA DO ASSISTENTE: "${reply.slice(0, 500)}"
CONTEXTO EMOCIONAL: score=${emotional.score.toFixed(2)}, trajetória=${emotional.trajectory}
Responda APENAS com JSON válido, sem markdown:
{ "relevance": <0-1>, "emotional_fit": <0-1>, "conciseness": <0-1>, "overall": <0-1>, "flag": "ok", "note": "" }`;
        
        const criticRes = await callOpenRouterWithPriority(4, 'if_full', `critic_${msg_id}`, [{ role: 'user', content: criticPrompt }], [], 'google/gemini-2.0-flash-001', 0.1, 4000, 200, 'none');
        if (criticRes?.content) {
          const criticScore = JSON.parse(criticRes.content.replace(/```json|```/g, ''));
          const history = await redis.get<any[]>(`critic_history_${userId}`) ?? [];
          await redis.set(`critic_history_${userId}`, [...history, criticScore].slice(-10), { ex: 86400 });
        }
      }));
    }

    // PATTERN PROMOTER (10%)
    if (Math.random() <= 0.10) {
      tasks.push(runIdempotentTask('pattern_promoter', msg_id, () => promotePatternToPrinciple(parseInt(userId), authorName, assistantName)));
    }

    // COMPACTAÇÃO
    tasks.push(runIdempotentTask('compact_memory', msg_id, async () => {
      const { count } = await supabase.from('brain').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('category', 'info');
      if (count && count >= 20) await compactMemory(userId, authorName);
    }));

    await Promise.allSettled(tasks);
    await redis.set(globalLockKey, 'completed', { ex: 604800 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    await redis.del(globalLockKey);
    return NextResponse.json({ error: 'Fail' }, { status: 500 });
  }
}