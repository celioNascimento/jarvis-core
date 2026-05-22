// lib/memory/index.ts — V2.2.4 (Contrato: Zero I/O via MasterContext Prioritário)
import { supabase } from '@/lib/jarvis';
import { compressToSummary, RAM_MAX_CHARS } from '@/lib/chat/ram';
import { detectTopicShiftWithL4, planContextualBlocks } from '@/lib/chat/context-classifier';
import { getRelatedTopics } from '@/lib/chat/topic-index';
import { buildRecommendationsBlock, buildTopicBlock } from '@/lib/extractor-jobs';
import { indexL3Chunks } from '@/lib/chat/l3-chunks';
import type { ContextType } from '@/lib/chat/context-classifier';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export type MemoryLayer = 'ram' | 'l3' | 'hd' | 'ashes' | 'events' | 'topics' | 'recommendations' | 'relationship';
export type MemoryWriteType = 'conversation' | 'fact' | 'recommendation' | 'event' | 'diary' | 'goal' | 'profile' | 'l3_patch' | 'relationship_memory' | 'relationship_event';

export interface RAMResult { recentPairs: Array<{ role: 'user' | 'assistant'; content: string }>; ramBlock: string; sessionId: string; }
export interface L3Result { content: string; themes: string[]; isFallback: boolean; }
export interface HDResult { memories: Array<MemoryItem>; block: string; memoryIds: string[]; }
export interface MemoryItem { id: string; summary: string; similarity: number; emotional_weight: number; }
export interface AshesResult { block: string; periods: Array<{ summary: string; period_start: string; period_end: string; }>; }
export interface EventsResult { upcoming: any[]; important: any[]; block: string; }
export interface TopicsResult { topicBlock: string; recommendationsBlock: string; relatedTopicsBlock: string; }
export interface RelationshipResult { hasData: boolean; block: string; sharedMemories: any[]; sharedEvents: any[]; hiddenItems: any[]; }

export interface MemoryReadResult {
  ram: RAMResult; l3: L3Result; hd: HDResult; ashes: AshesResult;
  events: EventsResult; topics: TopicsResult; relationship: RelationshipResult;
  meta: { userId: string; sessionId: string; layersLoaded: MemoryLayer[]; durationMs: number; };
}

export interface MemoryReadOptions {
  userId: number; authUserId: string; sessionId: string; queryEmbedding: number[] | null;
  contexts: string[]; message: string; emotionalScore: number; authorName: string;
  assistantName?: string; layers?: Partial<Record<MemoryLayer, boolean>>;
  masterContext?: any;
}

export interface MemoryWritePayload {
  type: MemoryWriteType; userId: number | string; authUserId?: string; relationshipId?: string;
  summary?: string; embedding?: number[]; emotionalWeight?: number; category?: string;
  title?: string; eventDate?: string; isRecurring?: boolean; notes?: string;
  sessionId?: string; messageText?: string; aiReply?: string; metadata?: Record<string, any>;
  dossie?: string; profileData?: Record<string, any>;
}

// ─── Leitores Blindados (Regra 1: Downstream) ───────────────────────────────

const ASSISTANT_REPLY_MAX = 800;
function trimAssistantReply(reply: string): string {
  if (!reply) return '';
  const cleaned = reply.replace(/\[.*?\]/g, '').trim();
  return cleaned.length > ASSISTANT_REPLY_MAX ? cleaned.slice(0, ASSISTANT_REPLY_MAX) + '…' : cleaned;
}

async function readRAM(options: MemoryReadOptions): Promise<RAMResult> {
  const { sessionId, masterContext, authorName, assistantName } = options;
  const safeSessionId = sessionId || 'default_session';
  const history = masterContext?.history || [];

  if (history.length === 0) return { recentPairs: [], ramBlock: '', sessionId: safeSessionId };

  const recentPairs = [...history].slice(0, 4).reverse().flatMap((h: any) => [
    { role: 'user' as const, content: h.content || '' },
    { role: 'assistant' as const, content: trimAssistantReply(h.metadata?.ai_reply || '') },
  ]);

  const ramBlock = [...history].reverse().map((h: any) =>
    `${authorName}: ${h.content}\n${assistantName || 'Lev'}: ${trimAssistantReply(h.metadata?.ai_reply || '')}`
  ).join('\n\n');

  return { recentPairs, ramBlock, sessionId: safeSessionId };
}

async function readL3(userId: number, queryEmbedding: number[] | null, dossier?: string): Promise<L3Result> {
  if (!queryEmbedding) return { content: dossier || '', themes: [], isFallback: true };
  const { data: results } = await supabase.rpc('match_l3_chunks', {
    query_embedding: queryEmbedding, p_user_id: userId, match_threshold: 0.3, match_count: 3
  });
  return {
    content: results?.length ? results.map((r: any) => r.content).join('\n\n') : (dossier || ''),
    themes: results?.map((r: any) => r.theme) || [],
    isFallback: !results?.length
  };
}

async function readHD(userId: number, queryEmbedding: number[] | null): Promise<HDResult> {
  if (!queryEmbedding) return { memories: [], block: '', memoryIds: [] };
  const { data: search } = await supabase.rpc('match_memories', {
    query_embedding: queryEmbedding, match_threshold: 0.22, match_count: 8
  });
  const memories: MemoryItem[] = (search || []).map((r: any) => ({
    id: r.id, summary: r.summary, similarity: r.similarity, emotional_weight: r.emotional_weight || 0.5
  }));
  return { memories, block: memories.map(m => m.summary).join('\n---\n'), memoryIds: memories.map(m => m.id) };
}

async function readEvents(userId: number, injectedEvents?: any[]): Promise<EventsResult> {
  const data = injectedEvents ?? [];
  const hoje = new Date();
  const upcoming = data.filter((e: any) => {
    const d = new Date(e.start_at);
    return d >= hoje && (d.getTime() - hoje.getTime()) / 86400000 <= 7;
  });
  const block = upcoming.length ? `🔴 PRÓXIMOS DIAS:\n${upcoming.map((e: any) => `- ${e.title}: ${e.start_at}`).join('\n')}` : 'Sem eventos.';
  return { upcoming, important: [], block };
}

// ─── Lógica Corrigida em lib/memory/index.ts ──────────────────────────────

async function readTopics(contexts: string[], masterContext: any): Promise<TopicsResult> {
  const safeContext = contexts.length > 0 ? contexts[0] : 'casual';

  // Funções Puras (Síncronas) - Retornam string diretamente, sem Promise
  const topicBlock = buildTopicBlock(masterContext);
  const recommendationsBlock = buildRecommendationsBlock(masterContext);

  let relatedTopicsBlock = '';
  try {
    // Chamada síncrona, sem await e sem .catch()
    relatedTopicsBlock = getRelatedTopics({ masterContext: safeContext });
  } catch (e) {
    relatedTopicsBlock = '';
  }

  return { topicBlock, recommendationsBlock, relatedTopicsBlock };
}

// ─── Agregador Principal ─────────────────────────────────────────────────────

export async function read(options: MemoryReadOptions): Promise<MemoryReadResult> {
  const start = Date.now();
  const { userId, masterContext, queryEmbedding, contexts, message, emotionalScore, sessionId } = options;
  const plan = planContextualBlocks(contexts as any[], message, emotionalScore);

  // 1. HD é a única camada que exige busca vetorial dinâmica
  const hd = plan.loadHD ? await readHD(userId, queryEmbedding) : { memories: [], block: '', memoryIds: [] };

  // 2. L3, Events e Topics: Priorizam o masterContext, buscam no banco APENAS se ausentes
  const [l3, events, topics, relationship, ashes] = await Promise.all([
    readL3(userId, queryEmbedding, masterContext?.dossier_summary),
    readEvents(userId, masterContext?.events),
    readTopics(contexts, masterContext), // Passando masterContext
    Promise.resolve<RelationshipResult>({ hasData: false, block: '', sharedMemories: [], sharedEvents: [], hiddenItems: [] }),
    Promise.resolve<AshesResult>({ block: '', periods: [] })
  ]);

  // 3. RAM processa o que o RPC já trouxe
  const ram = await readRAM(options);

  return {
    ram, l3, hd, ashes, events, topics, relationship,
    meta: { userId: String(userId), sessionId, layersLoaded: ['ram', 'events', 'hd', 'l3'], durationMs: Date.now() - start }
  };
}

export async function write(payload: MemoryWritePayload): Promise<void> {
  try {
    switch (payload.type) {
      case 'conversation':
        if (!payload.messageText || !payload.sessionId) return;
        await supabase.from('brain').insert([{
          content: payload.messageText, user_id: Number(payload.userId), session_id: payload.sessionId,
          category: payload.category || 'info', metadata: { ai_reply: payload.aiReply, ...payload.metadata }
        }]);
        break;
      case 'l3_patch':
        if (!payload.dossie) return;
        await supabase.from('users').update({ current_context: payload.dossie }).eq('id', Number(payload.userId));
        indexL3Chunks(Number(payload.userId), payload.dossie).catch(() => { });
        break;
    }
  } catch (e) { console.error('[MemoryManager/write] Erro:', e); }
}

export const MemoryManager = { read, write };
export default MemoryManager;
