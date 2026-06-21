// lib/jarvis.ts

import { createClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';
import { callOpenRouterWithPriority, ChatMessage } from '@/lib/chat/llm-gateway';

// ============================================================
// 1. CONEXÃO CENTRAL COM O BANCO E CACHE (SCHEMA JARVIS) — LAZY
// ============================================================

type JarvisSupabaseClient = ReturnType<typeof createClient<any, 'jarvis', any>>;

let _supabase: JarvisSupabaseClient | undefined;

function getSupabaseClient(): JarvisSupabaseClient {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
      throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não definidos em runtime.');
    }

    _supabase = createClient(url, key, { db: { schema: 'jarvis' } });

    if (process.env.NODE_ENV !== 'production') {
      const _from = _supabase.from.bind(_supabase);
      (_supabase as any).from = (table: string) => {
        const stack = new Error().stack?.split('\n')[2]?.trim() ?? '';
        console.log(`[DB] .from('${table}') → ${stack}`);
        return _from(table);
      };
    }
  }
  return _supabase;
}

export const supabase: JarvisSupabaseClient = new Proxy({} as JarvisSupabaseClient, {
  get(_target, prop, _receiver) {
    const client = getSupabaseClient();
    return Reflect.get(client as object, prop, client);
  },
});

let _redis: Redis | undefined;

function getRedisClient(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return _redis;
}

export const redis: Redis = new Proxy({} as Redis, {
  get(_target, prop, _receiver) {
    const client = getRedisClient();
    return Reflect.get(client as object, prop, client);
  },
});

// ============================================================
// 2. MOTOR DE IA (Gateway de Prioridade OpenRouter) — inalterado
// ============================================================

export async function callOpenRouter(
  input: string | ChatMessage[],
  model: string = "google/gemini-2.0-flash-001",
  temperature: number = 0.7,
  priority: 1 | 2 | 3 | 4 = 4
): Promise<string> {
  const taskId = `jarvis_internal_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const messages: ChatMessage[] = typeof input === 'string'
    ? [{ role: 'user', content: input }]
    : input;

  const dropPolicy = (priority === 3 || priority === 4) ? 'if_full' : 'never';

  const response: any = await callOpenRouterWithPriority(
    priority,
    dropPolicy,
    taskId,
    messages,
    undefined,
    model,
    temperature
  );

  return typeof response === 'string' ? response : (response.text || response.content || '');
}

// ============================================================
// 3. BARREL EXPORTS: COMPATIBILIDADE REVERSA ABSOLUTA
// ============================================================
export { getPartnerContextForChat } from './services/partner.service';
export { generateEmbedding } from './memory';
export { compactMemory, reinforceMemory } from './services/memory.service';
export { getProactiveEvents, checkSystemInterrupts } from './services/interrupts.service';
export { getOrCreateSession } from './services/session.service';
export { getPendingQuestion, setPendingQuestion, clearPendingQuestion } from './services/questions.service';
export { sendTelegram } from './services/telegram.service';