// app/api/jobs-processor/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase, generateEmbedding, compactMemory } from '@/lib/jarvis';
import { Redis } from '@upstash/redis';
import { runUnifiedExtractor } from '@/lib/chat/unified-extractor';
import { extractProfileFromConversation } from '@/lib/chat/profile-extractor';
import { promotePatternToPrinciple } from '@/lib/chat/pattern-promoter';
// IMPORT ATUALIZADO: Usando o Gatekeeper em vez da chamada direta
import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway'; 

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

async function runIdempotentTask(taskName: string, msg_id: string, taskFn: () => Promise<any>) {
  const taskKey = `task_done:${taskName}:${msg_id}`;
  if (await redis.get(taskKey)) return { status: 'skipped' };
  await taskFn();
  await redis.set(taskKey, 'true', { ex: 604800 });
  return { status: 'success' };
}

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    const { msg_id, userId, message, reply, contexts, emotional, authorName, assistantName, sessionId, modelRoute } = payload;

    const globalLockKey = `job_lock:${msg_id}`;
    if (!await redis.set(globalLockKey, 'processing', { nx: true, ex: 60 })) {
      return NextResponse.json({ ok: true, status: 'concurrent_skipped' });
    }

    try {
      // 1. SELF-HEALING AUTÔNOMO
      const { data: existingBrain } = await supabase
        .from('brain')
        .select('id')
        .eq('metadata->>msg_id', msg_id)
        .maybeSingle();

      if (!existingBrain) {
        const embedding = await generateEmbedding(message);
        await supabase.from('brain').insert([{
          content: message, user_id: userId, embedding,
          metadata: { ai_reply: reply, msg_id, recovered: true }
        }]);
      }

      // 2. ORQUESTRAÇÃO DE TAREFAS PARALELAS E IDEMPOTENTES
      const tasks = [
        runIdempotentTask('unified_extractor', msg_id, () => runUnifiedExtractor(userId, authorName, message, reply)),
        runIdempotentTask('profile_extractor', msg_id, () => extractProfileFromConversation(parseInt(userId), message, reply))
      ];

      // 3. TAREFAS PROBABILÍSTICAS (CRITIC & PROMOTER)
      if (Math.random() <= 0.30) {
        tasks.push(runIdempotentTask('critic', msg_id, async () => {
          // PROMPT RESTAURADO
          const criticPrompt = `Você é um avaliador interno de qualidade de um assistente de IA pessoal chamado ${assistantName}.
Avalie a resposta do assistente abaixo em 3 dimensões (0.0 a 1.0 cada):

MENSAGEM DO USUÁRIO: "${message.slice(0, 300)}"

RESPOSTA DO ASSISTENTE: "${reply.slice(0, 500)}"

CONTEXTO EMOCIONAL: score=${emotional.score.toFixed(2)}, trajetória=${emotional.trajectory}

Responda APENAS com JSON válido, sem markdown:
{
  "relevance": <0.0-1.0>,
  "emotional_fit": <0.0-1.0>,
  "conciseness": <0.0-1.0>,
  "overall": <0.0-1.0>,
  "flag": <"ok"|"verbose"|"cold"|"off_topic"|"missed_emotion">,
  "note": "<observação curta em português, máx 20 palavras>"
}`;
          
          // CHAMADA VIA GATEKEEPER (Prioridade 4, descarte se cheio)
          const criticRes = await callOpenRouterWithPriority(
            4, 
            'if_full', 
            `critic_${msg_id}`, 
            [{ role: 'user', content: criticPrompt }], 
            [], 
            'google/gemini-2.0-flash-001', 
            0.1, 
            4000, 
            200, 
            'none'
          );

          if (criticRes?.content) {
            const criticScore = JSON.parse(criticRes.content.replace(/```json|```/g, ''));
            const historyKey = `critic_history_${userId}`;
            const history = await redis.get<any[]>(historyKey) ?? [];
            await redis.set(historyKey, [...history, criticScore].slice(-10), { ex: 86400 });
          }
        }));
      }

      if (Math.random() <= 0.10) {
        tasks.push(runIdempotentTask('pattern_promoter', msg_id, async () => {
          const res = await promotePatternToPrinciple(parseInt(userId), authorName, assistantName);
          if (res.notification) await redis.set(`pending_notification_${userId}`, res.notification, { ex: 86400 });
        }));
      }

      // 4. COMPACTAÇÃO DE MEMÓRIA (Condicional)
      tasks.push(runIdempotentTask('compact_memory', msg_id, async () => {
        const { count } = await supabase.from('brain').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('category', 'info');
        if (count && count >= 20) await compactMemory(userId, authorName);
      }));

      // Executa tudo e consolida falhas
      const results = await Promise.allSettled(tasks);
      if (results.some(r => r.status === 'rejected')) {
        await redis.del(globalLockKey);
        await redis.incr(`failure_counter:${userId}:background`);
        return NextResponse.json({ error: 'Partial failure' }, { status: 500 }); // Retry requested
      }

      await redis.set(globalLockKey, 'completed', { ex: 604800 });
      await redis.del(`failure_counter:${userId}:background`);
      return NextResponse.json({ ok: true });

    } catch (innerError) {
      await redis.del(globalLockKey);
      throw innerError;
    }
  } catch (error) {
    return NextResponse.json({ error: 'Fatal error' }, { status: 500 });
  }
}
