// app/api/chat/route.ts — V8.14.3 (fix sessionId sync)
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
    const body = await (req.headers.get('content-type')?.includes('multipart')
      ? req.formData()
      : req.json());

    const message     = body instanceof FormData ? body.get('message')     as string : body.message;
    const userEmail   = body instanceof FormData ? body.get('userEmail')   as string : body.userEmail;
    // ✅ FIX: lê o sessionId enviado pelo app
    const incomingSessionId = body instanceof FormData
      ? (body.get('sessionId') as string | null)
      : (body.sessionId as string | null);

    // 1. Resolve Usuário
    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!user) return NextResponse.json({ error: 'Auth failed' }, { status: 401 });

    // ✅ FIX: usa o sessionId do app se válido, só cria um novo se não vier nenhum
    const sessionId = incomingSessionId || await getOrCreateSession(String(user.id));

    // ── DEDUPLICAÇÃO GLOBAL ──────────────────────────────────────────────────
    const requestSignature = `${sessionId}_${Buffer.from(message.substring(0, 50)).toString('base64')}`;
    const dedupKey  = `chat_dedup:${requestSignature}`;
    const replyKey  = `chat_reply:${requestSignature}`;

    const isFirst = await redis.set(dedupKey, '1', { nx: true, ex: 30 });

    if (!isFirst) {
      console.warn('[Dedup] Retry detectado, aguardando reply cacheado...');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const cached = await redis.get<string>(replyKey);
        if (cached) {
          console.log('[Dedup] Reply cacheado encontrado, retornando.');
          return NextResponse.json({
            reply: cached,
            ok: true,
            sessionId,
            performance: '0ms (dedup)',
          });
        }
      }
      console.warn('[Dedup] Timeout esperando reply. Deixando passar.');
    }
    // ────────────────────────────────────────────────────────────────────────

    const queryEmbedding = await getCachedEmbedding(message).catch(() => null);

    // 2. Inteligência de Contexto
    const [isStressed, contexts, emotional] = await Promise.all([
      llmGateway.isOverloaded(),
      classifyContextWithL4(message, String(user.id)),
      computeEmotionalScore(message, String(user.id), [], ''),
    ]);

    // 3. Carregamento Modular
    const { contextBlocks, activeTools, resolvedModel } = await loadActiveModules(
      {
        userId: String(user.id),
        authUserId: user.auth_user_id,
        message,
        contexts,
        emotionalScore: emotional.score,
      },
      user.plan || 'free',
      'google/gemini-2.0-flash-001',
    );

    // 4. Memória e Prompt Engine
    const memory = await MemoryManager.read({
      userId:        String(user.id),
      authUserId:    user.auth_user_id,
      sessionId,
      message,
      contexts,
      emotionalScore:  emotional.score,
      authorName:      user.nickname,
      assistantName:   user.assistant_name,
      queryEmbedding:  queryEmbedding,
    });

    // 5. Composição do Prompt e Filtragem de Ferramentas
    const coreTools = ['salvar_evento', 'create_reminder', 'searchWeb', 'buscar_memoria_longa'];
    const toolsHabilitadas = ALL_TOOLS.filter(t =>
      coreTools.includes(t.function.name) || activeTools.includes(t.function.name)
    );

    const systemPrompt = composeSystemPrompt({
      assistantName: user.assistant_name,
      authorName:    user.nickname,
      isLikelyNoise: message.length < 15,
      isSystemStressed: isStressed,
      emotionalScore:   emotional.score,
      detectedContexts: contexts,
      contextBlocks,
      memoryBlocks: {
        truncatedL3:     memory.l3.content.slice(0, 3000),
        truncatedHd:     memory.hd.block.slice(0, 4000),
        truncatedEvents: memory.events.block.slice(0, 2000),
        relationship:    memory.relationship.block.slice(0, 2000),
        topics:          memory.topics.relatedTopicsBlock,
      },
      canonicalDateTimeBlock: new Date().toLocaleString('pt-BR'),
      canonicalDateISO:       new Date().toISOString().split('T')[0],
      systemWarning:    '',
      intent:           'personal',
      dynamicGuidelines: '',
    });

    // 6. Execução via Gateway
    const response = await callOpenRouterWithPriority(
      1,
      'never',
      requestSignature,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: message },
      ],
      toolsHabilitadas,
      resolvedModel,
      0.7,
    );

    const assistantReply = (response as any).content || 'Processado.';

    // Cacheia o reply para o retry da Vercel recuperar
    await redis.set(replyKey, assistantReply, { ex: 30 }).catch(() => {});

    // 7. Salvamento no brain
    try {
      const cat = message.length < 15 ? 'noise' : 'info';

      await supabase.from('brain').insert({
        user_id:    Number(user.id),
        session_id: sessionId,          // ✅ usa o sessionId resolvido
        content:    message,
        category:   cat,
        project_tag: 'geral',
        metadata: {
          role:     'user',
          ai_reply: assistantReply,
          contexts: contexts,
          model:    resolvedModel,
        },
      });
    } catch (dbErr) {
      console.error('[DB] Erro ao salvar no brain:', dbErr);
    }

    // ✅ FIX: retorna sessionId para o app sincronizar
    return NextResponse.json({
      reply: assistantReply,
      ok:    true,
      sessionId,
      performance: `${Date.now() - startTime}ms`,
    });

  } catch (e: any) {
    console.error('[FATAL]', e);
    return NextResponse.json({ error: 'Erro interno no motor.' }, { status: 500 });
  }
}