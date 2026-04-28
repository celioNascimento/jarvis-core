import { NextRequest, NextResponse } from 'next/server';
import { supabase, getOrCreateSession, clearPendingQuestion } from '@/lib/jarvis';
import { classifyTemporalHorizon, truncateByWeight } from '@/lib/context-router';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import { classifyContextWithL4 } from '@/lib/chat/context-classifier';
import { tools } from '@/lib/chat/tools-def';
import { executeTool } from '@/lib/chat/tools-executor';
import { computeEmotionalScore } from '@/lib/chat/emotional-router';
import { Redis } from '@upstash/redis';
import { MemoryManager } from '@/lib/memory';
import { callOpenRouterWithPriority, llmGateway } from '@/lib/chat/llm-gateway';
import { loadActiveModules } from '@/lib/modules/registry';
import { composeSystemPrompt } from '@/lib/chat/prompt-engine';

export const maxDuration = 60;
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });

export async function POST(req: NextRequest) {
  const totalStartTime = Date.now();
  try {
    const body = await (req.headers.get('content-type')?.includes('multipart') ? req.formData() : req.json());
    const messageRaw = body instanceof FormData ? body.get('message') as string : body.message;
    const userEmail = body instanceof FormData ? body.get('userEmail') as string : body.userEmail;
    const location = body instanceof FormData ? null : body.location;

    const { data: userRecord } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!userRecord) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const numericUserIdStr = String(userRecord.id);
    const authUserId = userRecord.auth_user_id;
    const authorName = userRecord.nickname || 'Usuário';
    const assistantName = userRecord.assistant_name || 'Lev';
    const msg_id = crypto.randomUUID();

    const isSystemStressed = await llmGateway.isOverloaded();
    const detectedContexts = await classifyContextWithL4(messageRaw, numericUserIdStr);
    const queryEmbedding = await getCachedEmbedding(messageRaw).catch(() => null);
    const emotional = await computeEmotionalScore(messageRaw, numericUserIdStr, [], '');

    // ─── CARREGAMENTO MODULAR ───
    const { contextBlocks, activeTools, resolvedModel } = await loadActiveModules(
      { userId: numericUserIdStr, authUserId, message: messageRaw, location, contexts: detectedContexts, emotionalScore: emotional.score },
      userRecord.plan ?? 'free',
      'google/gemini-2.0-flash-001'
    );

    // ─── MEMÓRIA E PROMPT ───
    const memory = await MemoryManager.read({ userId: numericUserIdStr, authUserId, sessionId: 'default', queryEmbedding, contexts: detectedContexts, message: messageRaw, emotionalScore: emotional.score, authorName, assistantName });
    const weights = classifyTemporalHorizon(messageRaw, memory.ram.ramBlock, userRecord.pending_question);
    
    const systemPrompt = composeSystemPrompt({
      assistantName, authorName, isLikelyNoise: messageRaw.length < 10, isSystemStressed,
      emotionalScore: emotional.score, detectedContexts, contextBlocks,
      canonicalDateTimeBlock: new Date().toLocaleString('pt-BR'), canonicalDateISO: new Date().toISOString().split('T')[0],
      memoryBlocks: {
        truncatedL3: truncateByWeight(memory.l3.content, weights.l3, 4000),
        truncatedHd: truncateByWeight(memory.hd.block, weights.hd, 4000),
        truncatedEvents: truncateByWeight(memory.events.block, weights.events, 4000),
        relationship: memory.relationship.block,
        topics: memory.topics.relatedTopicsBlock,
      },
      systemWarning: '', intent: 'personal', dynamicGuidelines: ''
    });

    // ─── FILTRAGEM DE TOOLS ───
    const coreTools = ['salvar_evento', 'create_reminder'];
    const toolsHabilitadas = tools.filter(t => coreTools.includes(t.function.name) || activeTools.includes(t.function.name));

    // ─── EXECUÇÃO ───
    let conversationMessages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: messageRaw }];
    const response = await callOpenRouterWithPriority(1, 'never', msg_id, conversationMessages, toolsHabilitadas, resolvedModel, 0.7);
    
    const finalResponse = (response as any).content || 'Processado.';

    return NextResponse.json({ reply: finalResponse, ok: true });

  } catch (error: any) {
    console.error('[FATAL]', error);
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}
