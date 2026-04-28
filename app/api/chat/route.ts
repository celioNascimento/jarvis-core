// app/api/chat/route.ts — V8.14.0 (Blindado e Modular)

import { NextRequest, NextResponse } from 'next/server';
import { supabase, getOrCreateSession, clearPendingQuestion } from '@/lib/jarvis';
import { classifyTemporalHorizon, truncateByWeight } from '@/lib/context-router';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';
import { classifyContextWithL4, routeModel, getTemperature } from '@/lib/chat/context-classifier';
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
    // 1. Extração de Dados (Multipart ou JSON)
    const body = await (req.headers.get('content-type')?.includes('multipart') ? req.formData() : req.json());
    const messageRaw = body instanceof FormData ? body.get('message') as string : body.message;
    const userEmail = body instanceof FormData ? body.get('userEmail') as string : body.userEmail;
    const location = body instanceof FormData ? null : body.location; // Simplificado para o exemplo

    // 2. Identificação do Usuário
    const { data: userRecord } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!userRecord) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const numericUserIdStr = String(userRecord.id);
    const authUserId = userRecord.auth_user_id;
    const authorName = userRecord.nickname || 'Usuário';
    const assistantName = userRecord.assistant_name || 'Lev';
    const msg_id = crypto.randomUUID();

    // 3. Sensores e Inteligência de Contexto
    const isSystemStressed = await llmGateway.isOverloaded();
    const detectedContexts = await classifyContextWithL4(messageRaw, numericUserIdStr);
    const queryEmbedding = await getCachedEmbedding(messageRaw).catch(() => null);
    const emotional = await computeEmotionalScore(messageRaw, numericUserIdStr, [], '');
    
    // 4. CARREGAMENTO MODULAR (A NOVA ARQUITETURA)
    const { contextBlocks, activeTools, resolvedModel } = await loadActiveModules(
      { userId: numericUserIdStr, authUserId, message: messageRaw, location, contexts: detectedContexts, emotionalScore: emotional.score },
      userRecord.plan ?? 'free',
      'google/gemini-2.0-flash-001'
    );

    // 5. Memória e Truncagem
    const memory = await MemoryManager.read({ userId: numericUserIdStr, authUserId, sessionId: 'default', queryEmbedding, contexts: detectedContexts, message: messageRaw, emotionalScore: emotional.score, authorName, assistantName });
    const weights = classifyTemporalHorizon(messageRaw, memory.ram.ramBlock, userRecord.pending_question);
    
    // 6. MONTAGEM DO PROMPT VIA ENGINE
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

    // 7. Loop de Execução ReAct
    let finalResponse = '';
    let conversationMessages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: messageRaw }];
    const herramientasFiltradas = tools.filter(t => ['salvar_evento', 'create_reminder'].includes(t.function.name) || activeTools.includes(t.function.name));

    // Chamada LLM via Gateway
    const response = await callOpenRouterWithPriority(1, 'never', msg_id, conversationMessages, ferramentasFiltradas, resolvedModel, 0.7);
    finalResponse = (response as any).content || 'Processado.';

    // 8. Sync e Despacho Assíncrono (QStash)
    // [Seu código de QStash e RAM Sync aqui...]

    return NextResponse.json({ reply: finalResponse, ok: true });

  } catch (error: any) {
    console.error('[FATAL]', error);
    return NextResponse.json({ error: 'Erro no motor' }, { status: 500 });
  }
}
