// lib/jarvis.ts
// V12.0.1 — Thin Core Container & Barrel Exports (Tipagem de ChatMessage alinhada)

import { createClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';
import { callOpenRouterWithPriority, ChatMessage } from '@/lib/chat/llm-gateway'; // ← Importando a tipagem centralizada

// ============================================================
// 1. CONEXÃO CENTRAL COM O BANCO E CACHE (SCHEMA JARVIS)
// ============================================================
export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

// ── Diagnóstico temporário — remover após identificar as queries ──────────────
if (process.env.NODE_ENV !== 'production') {
  const _from = supabase.from.bind(supabase);
  (supabase as any).from = (table: string) => {
    const stack = new Error().stack?.split('\n')[2]?.trim() ?? '';
    console.log(`[DB] .from('${table}') → ${stack}`);
    return _from(table);
  };
}

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ============================================================
// 2. MOTOR DE IA (Gateway de Prioridade OpenRouter)
// ============================================================

export async function callOpenRouter(
  input: string | ChatMessage[],
  model: string = "google/gemini-2.0-flash-001",
  temperature: number = 0.7,
  priority: 1 | 2 | 3 | 4 = 4 // Default para Background
): Promise<string> {
  const taskId = `jarvis_internal_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  // ← Forçando a tipagem explícita para evitar inferência genérica do TypeScript
  const messages: ChatMessage[] = typeof input === 'string' 
    ? [{ role: 'user', content: input }] 
    : input;
  
  const dropPolicy = (priority === 3 || priority === 4) ? 'if_full' : 'never';

  const response: any = await callOpenRouterWithPriority(
    priority,
    dropPolicy,
    taskId,
    messages,
    undefined, // ← Passando undefined em vez de [] para limpeza estrita de payload no Gateway
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
