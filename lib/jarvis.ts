  // lib/jarvis.ts
// V12.0.0 — Thin Core Container & Barrel Exports

import { createClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';
import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway'; 

// ============================================================
// 1. CONEXÃO CENTRAL COM O BANCO E CACHE (SCHEMA JARVIS)
// ============================================================
export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ============================================================
// 2. MOTOR DE IA (Gateway de Prioridade OpenRouter)
// ============================================================
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export async function callOpenRouter(
  input: string | ChatMessage[],
  model: string = "google/gemini-2.0-flash-001",
  temperature: number = 0.7,
  priority: 1 | 2 | 3 | 4 = 4 // Default para Background
): Promise<string> {
  const taskId = `jarvis_internal_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  
  const dropPolicy = (priority === 3 || priority === 4) ? 'if_full' : 'never';

  const response: any = await callOpenRouterWithPriority(
    priority,
    dropPolicy,
    taskId,
    messages,
    [], // Sem tools
    model,
    temperature
  );

  return typeof response === 'string' ? response : (response.text || response.content || '');
}

// ============================================================
// 3. BARREL EXPORTS: COMPATIBILIDADE REVERSA ABSOLUTA
// ============================================================
export { getPartnerContextForChat } from './services/partner.service';
export { generateEmbedding, compactMemory, reinforceMemory } from './services/memory.service';
export { getProactiveEvents, checkSystemInterrupts } from './services/interrupts.service';
export { getOrCreateSession } from './services/session.service';
export { getPendingQuestion, setPendingQuestion, clearPendingQuestion } from './services/questions.service';
export { sendTelegram } from './services/telegram.service';
