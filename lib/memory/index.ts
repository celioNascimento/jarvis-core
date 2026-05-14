// lib/memory/index.ts — V2.2.2 (Fix: userId as Number & ContextType cast)
import { supabase } from '@/lib/jarvis';
import { compressToSummary, semanticRamCompression, RAM_MAX_CHARS } from '@/lib/chat/ram';
import { detectTopicShiftWithL4 } from '@/lib/chat/context-classifier';
import { getRelatedTopics } from '@/lib/chat/topic-index';
import { buildRecommendationsBlock, buildTopicBlock } from '@/lib/extractor-jobs';
import { planContextualBlocks } from '@/lib/chat/context-classifier';
import { generateEmbedding } from '@/lib/jarvis';
import { indexL3Chunks } from '@/lib/chat/l3-chunks';
import type { ContextType } from '@/lib/chat/context-classifier';

// ─── Interfaces e Tipos ──────────────────────────────────────────────────────

export type MemoryLayer = 'ram' | 'l3' | 'hd' | 'ashes' | 'events' | 'topics' | 'recommendations' | 'relationship';

export type MemoryWriteType = 
  | 'conversation' | 'fact' | 'recommendation' | 'event' | 'diary' 
  | 'goal' | 'profile' | 'l3_patch' | 'relationship_memory' | 'relationship_event';

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
  // ✅ CORREÇÃO AQUI: userId passa a ser number em toda a arquitetura da Memória
  userId: number; 
  authUserId: string; sessionId: string; queryEmbedding: number[] | null;
  contexts: string[]; message: string; emotionalScore: number; authorName: string;
  assistantName?: string; layers?: Partial<Record<MemoryLayer, boolean>>;
  masterContext?: any; 
}

export interface MemoryWritePayload {
  // ✅ CORREÇÃO: tipando como number/string para garantir flexibilidade no insert
  type: MemoryWriteType; userId: number | string; authUserId?: string; relationshipId?: string;
  summary?: string; embedding?: number[]; emotionalWeight?: number; category?: string;
  title?: string; eventDate?: string; isRecurring?: boolean; notes?: string;
  sessionId?: string; messageText?: string; aiReply?: string; metadata?: Record<string, any>;
  dossie?: string; profileData?: Record<string, any>;
}

// ─── Auxiliares ──────────────────────────────────────────────────────────────

const ASSISTANT_REPLY_MAX = 800;
function trimAssistantReply(reply: string, maxChars = ASSISTANT_REPLY_MAX): string {
  if (!reply) return '';
  const cleaned = reply.replace(/\[.*?\]/g, '').trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) + '…' : cleaned;
}

// ─── Leitores por Camada ─────────────────────────────────────────────────────

async function readRAM(options: MemoryReadOptions, hdBlock: string, injectedHistory?: any[]): Promise<RAMResult> {
  try {
    const { userId, sessionId, contexts, authorName, assistantName } = options;
    const safeSessionId = sessionId || 'default_session';
    let historySession: any[] = injectedHistory ?? [];

    if (historySession.length === 0) {
      const { data } = await supabase.from('brain').select('content, metadata')
        .eq('user_id', userId).eq('session_id', safeSessionId)
        .neq('category', 'archived').order('created_at', { ascending: false }).limit(6);
      historySession = data ?? [];
    }

    if (historySession.length === 0) return { recentPairs: [], ramBlock: '', sessionId: safeSessionId };

    const hasEnoughHistory = historySession.length >= 2;
    // ✅ Agora o userId já é number, o classificador vai aceitar perfeitamente
    const shiftDetected = hasEnoughHistory
      ? await detectTopicShiftWithL4(userId, contexts as ContextType[])
      : false;
    
    const recentPairs = [...historySession].slice(0, shiftDetected ? 1 : 4).reverse().flatMap((h: any) => [
      { role: 'user' as const, content: h.content || '' },
      { role: 'assistant' as const, content: trimAssistantReply(h.metadata?.ai_reply || '') },
    ]);

    let ramBlock = '';
    if (shiftDetected) {
        ramBlock = `[CONTEXTO ANTERIOR RESUMIDO]\n(Usuário iniciou novo tópico)`;
    } else {
        ramBlock = [...historySession].reverse().map((h: any) => 
            `${authorName}: ${h.content}\n${assistantName || 'Lev'}: ${trimAssistantReply(h.metadata?.ai_reply || '')}`
        ).join('\n\n');
    }

    return { recentPairs, ramBlock, sessionId: safeSessionId };
  } catch (e) { 
    return { recentPairs: [], ramBlock: '', sessionId: options.sessionId }; 
  }
}

async function readL3(userId: number, queryEmbedding: number[] | null, injectedDossier?: string): Promise<L3Result> {
  if (!queryEmbedding) return { content: injectedDossier || '', themes: [], isFallback: true };
  const { data: results, error } = await supabase.rpc('match_l3_chunks', {
    query_embedding: queryEmbedding, p_user_id: userId, match_threshold: 0.3, match_count: 3
  });
  if (error || !results?.length) return { content: injectedDossier || '', themes: [], isFallback: true };
  return { content: results.map((r: any) => r.content).join('\n\n'), themes: results.map((r: any) => r.theme), isFallback: false };
}

async function readHD(userId: number, queryEmbedding: number[] | null, contexts: string[], emotionalScore: number): Promise<HDResult> {
  if (!queryEmbedding) return { memories: [], block: '', memoryIds: [] };
  const { data: search } = await supabase.rpc('match_memories', {
    query_embedding: queryEmbedding, match_threshold: 0.22, match_count: 8
  });
  
  const memories: MemoryItem[] = (search || []).map((r: any) => ({ 
    id: r.id, 
    summary: r.summary, 
    similarity: r.similarity, 
    emotional_weight: r.emotional_weight || 0.5 
  }));

  return { 
    memories, 
    block: memories.map((m: MemoryItem) => m.summary).join('\n---\n'), 
    memoryIds: memories.map((m: MemoryItem) => m.id) 
  };
}

async function readEvents(userId: number, canonicalDateISO: string, injectedEvents?: any[]): Promise<EventsResult> {
  let data = injectedEvents ?? [];
  if (data.length === 0) {
    const { data: fetched } = await supabase.from('events').select('title, start_at, description').eq('user_id', userId).order('start_at', { ascending: true });
    data = fetched ?? [];
  }
  const hoje = new Date(canonicalDateISO);
  const upcoming = data.filter((e: any) => {
    const d = new Date(e.start_at);
    return d >= hoje && (d.getTime() - hoje.getTime()) / 86400000 <= 7;
  });
  const block = upcoming.length ? `🔴 PRÓXIMOS DIAS:\n${upcoming.map((e: any) => `- ${e.title}: ${e.start_at}`).join('\n')}` : 'Sem eventos.';
  return { upcoming, important: [], block };
}

async function readTopics(userId: number, contexts: string[], message: string): Promise<TopicsResult> {
    try {
        const safeContext = contexts.length > 0 ? contexts[0] : 'casual';
        const [topicBlock, recommendationsBlock, relatedTopicsBlock] = await Promise.all([
            buildTopicBlock(String(userId), message).catch(() => ''), // Mantido String apenas para os extratores que não refatoramos
            buildRecommendationsBlock(String(userId), message).catch(() => ''),
            getRelatedTopics(String(userId), safeContext).catch(() => '')
        ]);
        return { topicBlock, recommendationsBlock, relatedTopicsBlock };
    } catch {
        return { topicBlock: '', recommendationsBlock: '', relatedTopicsBlock: '' };
    }
}

// ─── Agregador Principal ─────────────────────────────────────────────────────

export async function read(options: MemoryReadOptions): Promise<MemoryReadResult> {
  const start = Date.now();
  const { userId, masterContext, queryEmbedding, contexts, message, emotionalScore, authorName, sessionId } = options;
  const plan = planContextualBlocks(contexts as any[], message, emotionalScore);

  const hd = plan.loadHD ? await readHD(userId, queryEmbedding, contexts, emotionalScore) : { memories: [], block: '', memoryIds: [] };

  const [l3, events, topics, relationship, ashes] = await Promise.all([
    readL3(userId, queryEmbedding, masterContext?.dossier_summary),
    readEvents(userId, new Date().toISOString().split('T')[0], masterContext?.events),
    readTopics(userId, contexts, message),
    Promise.resolve<RelationshipResult>({ hasData: false, block: '', sharedMemories: [], sharedEvents: [], hiddenItems: [] }),
    Promise.resolve<AshesResult>({ block: '', periods: [] })
  ]);

  const ram = await readRAM(options, hd.block, masterContext?.history);

  return {
    ram, l3, hd, ashes, events, topics, relationship,
    meta: { userId: String(userId), sessionId, layersLoaded: ['ram', 'events', 'hd', 'l3'], durationMs: Date.now() - start }
  };
}

// ─── Escritor ────────────────────────────────────────────────────────────────

export async function write(payload: MemoryWritePayload): Promise<void> {
  try {
    switch (payload.type) {
      case 'conversation':
        if (!payload.messageText || !payload.sessionId) return;
        await supabase.from('brain').insert([{
          content: payload.messageText, user_id: Number(payload.userId), session_id: payload.sessionId,
          category: payload.category || 'info', project_tag: 'geral',
          metadata: { ai_reply: payload.aiReply, ...payload.metadata }
        }]);
        break;
      case 'l3_patch':
        if (!payload.dossie) return;
        await supabase.from('users').update({ current_context: payload.dossie }).eq('id', Number(payload.userId));
        indexL3Chunks(Number(payload.userId), payload.dossie).catch(() => {});
        break;
    }
  } catch (e) { console.error('[MemoryManager/write] Erro:', e); }
}

export const MemoryManager = { read, write };
export default MemoryManager;
