// app/api/chat/route.ts — V8.14.2 (Anti-dupla-execução + histórico corrigido)
import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { supabase, getOrCreateSession } from '@/lib/jarvis';
import { classifyContextWithL4 } from '@/lib/chat/context-classifier';
import { computeEmotionalScore } from '@/lib/chat/emotional-router';
import { MemoryManager } from '@/lib/memory';
import { callOpenRouterWithPriority, llmGateway } from '@/lib/chat/llm-gateway';
import { loadActiveModules } from '@/lib/modules/registry';
import { composeSystemPrompt } from '@/lib/chat/prompt-engine';
import { tools as ALL_TOOLS } from '@/lib/chat/tools-def';
import { getCachedEmbedding } from '@/lib/chat/embedding-cache';

export const maxDuration = 60;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    const body = await (req.headers.get('content-type')?.includes('multipart') ? req.formData() : req.json());
    const message = body instanceof FormData ? body.get('message') as string : body.message;
    const userEmail = body instanceof FormData ? body.get('userEmail') as string : body.userEmail;

    // 1. Resolve Usuário e Sessão
    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!user) return NextResponse.json({ error: 'Auth failed' }, { status: 401 });
    const sessionId = await getOrCreateSession(String(user.id));

    // ── DEDUPLICAÇÃO GLOBAL (bloqueia retry da Vercel antes de qualquer processamento) ──
    const requestSignature = `${sessionId}_${Buffer.from(message.substring(0, 50)).toString('base64')}`;
    const dedupKey = `chat_dedup:${requestSignature}`;
    const replyKey = `chat_reply:${requestSignature}`;

    const isFirst = await redis.set(dedupKey, '1', { nx: true, ex: 30 });

    if (!isFirst) {
      // É um retry da Vercel — aguarda a primeira instância terminar e devolve o reply cacheado
      console.warn('[Dedup] Retry detectado, aguardando reply cacheado...');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const cached = await redis.get<string>(replyKey);
        if (cached) {
          console.log('[Dedup] Reply cacheado encontrado, retornando.');
          return NextResponse.json({ reply: cached, ok: true, performance: '0ms (dedup)' });
        }
      }
      // Se após 15s ainda não tem cache, deixa passar para não travar o usuário
      console.warn('[Dedup] Timeout esperando reply. Deixando passar.');
    }
    // ──────────────────────────────────────────────────────────────────────────────────

    const queryEmbedding = await getCachedEmbedding(message).catch(() => null);

    // 2. Inteligência de Contexto (Sensores)
    const [isStressed, contexts, emotional] = await Promise.all([
      llmGateway.isOverloaded(),
      classifyContextWithL4(message, String(user.id)),
      computeEmotionalScore(message, String(user.id), [], '')
    ]);

    // 3. Carregamento Modular
    const { contextBlocks, activeTools, resolvedModel } = await loadActiveModules(
      { userId: String(user.id), authUserId: user.auth_user_id, message, contexts, emotionalScore: emotional.score },
      user.plan || 'free',
      'google/gemini-2.0-flash-001'
    );

    // 4. Memória e Prompt Engine
    const memory = await MemoryManager.read({
      userId: String(user.id),
      authUserId: user.auth_user_id,
      sessionId,
      message,
      contexts,
      emotionalScore: emotional.score,
      authorName: user.nickname,
      assistantName: user.assistant_name,
      queryEmbedding: queryEmbedding,
    });

    // 5. Composição do Prompt e Filtragem de Ferramentas
    const coreTools = ['salvar_evento', 'create_reminder', 'searchWeb', 'buscar_memoria_longa'];
    const toolsHabilitadas = ALL_TOOLS.filter(t =>
      coreTools.includes(t.function.name) ||
      activeTools.includes(t.function.name)
    );

    const systemPrompt = composeSystemPrompt({
      assistantName: user.assistant_name,
      authorName: user.nickname,
      isLikelyNoise: message.length < 15,
      isSystemStressed: isStressed,
      emotionalScore: emotional.score,
      detectedContexts: contexts,
      contextBlocks,
      memoryBlocks: {
        truncatedL3: memory.l3.content.slice(0, 3000),
        truncatedHd: memory.hd.block.slice(0, 4000),
        truncatedEvents: memory.events.block.slice(0, 2000),
        relationship: memory.relationship.block.slice(0, 2000),
        topics: memory.topics.relatedTopicsBlock
      },
      canonicalDateTimeBlock: new Date().toLocaleString('pt-BR'),
      canonicalDateISO: new Date().toISOString().split('T')[0],
      systemWarning: '',
      intent: 'personal',
      dynamicGuidelines: ''
    });

    // 6. Execução via Gateway
    const response = await callOpenRouterWithPriority(
      1,
      'never',
      requestSignature,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      toolsHabilitadas,
      resolvedModel,
      0.7
    );

    const assistantReply = (response as any).content || 'Processado.';

    // Cacheia o reply para o retry da Vercel recuperar
    await redis.set(replyKey, assistantReply, { ex: 30 }).catch(() => {});

    // 7. Salvamento — uma linha por par com ai_reply no metadata
    // loadHistory lê h.content como mensagem do usuário
    // e h.metadata.ai_reply como resposta do assistente
    try {
      const cat = message.length < 15 ? 'noise' : 'info';

      await supabase.from('brain').insert({
        user_id: Number(user.id),
        session_id: sessionId,
        content: message,
        category: cat,
        project_tag: 'geral',
        metadata: {
          role: 'user',
          ai_reply: assistantReply,
          contexts: contexts,
          model: resolvedModel,
        }
      });
    } catch (dbErr) {
      console.error('[DB] Erro ao salvar no brain:', dbErr);
    }

    return NextResponse.json({
      reply: assistantReply,
      ok: true,
      performance: `${Date.now() - startTime}ms`
    });

  } catch (e: any) {
    console.error('[FATAL]', e);
    return NextResponse.json({ error: 'Erro interno no motor.' }, { status: 500 });
  }
}