// app/api/chat/route.ts — V8.14.0 (Blindado)
import { NextRequest, NextResponse } from 'next/server';
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
    const queryEmbedding = await getCachedEmbedding(message).catch(() => null);

    // 2. Inteligência de Contexto (Sensores)
    const [isStressed, contexts, emotional] = await Promise.all([
      llmGateway.isOverloaded(),
      classifyContextWithL4(message, String(user.id)),
      computeEmotionalScore(message, String(user.id), [], '')
    ]);

    // 3. CARREGAMENTO MODULAR (O coração da nova arquitetura)
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
      queryEmbedding: queryEmbedding // <--- Resolve o erro do build
    });

   // 5. Composição do Prompt e Filtragem de Ferramentas (Blindado)

    // A. Definimos as ferramentas essenciais que o Jarvis SEMPRE deve ter acesso
    const coreTools = ['salvar_evento', 'create_reminder', 'searchWeb', 'buscar_memoria_longa'];

    // B. Filtramos a lista gigante (ALL_TOOLS) para deixar apenas o essencial + módulos ativos
    const toolsHabilitadas = ALL_TOOLS.filter(t =>
      coreTools.includes(t.function.name) ||
      activeTools.includes(t.function.name)
    );

    // C. Montamos o System Prompt com as memórias limitadas sob medida (Truncagem)
    const systemPrompt = composeSystemPrompt({
      assistantName: user.assistant_name,
      authorName: user.nickname,
      isLikelyNoise: message.length < 15,
      isSystemStressed: isStressed,
      emotionalScore: emotional.score,
      detectedContexts: contexts,
      contextBlocks,
      memoryBlocks: {
        // Limites de segurança para não estourar a janela de contexto da LLM
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

    // 6. Execução via Gateway (Enviando tudo para a Inteligência Artificial)
    const response = await callOpenRouterWithPriority(
      1, 
      'never', 
      crypto.randomUUID(), 
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ], 
      toolsHabilitadas, // <--- Aqui injetamos apenas as ferramentas permitidas
      resolvedModel, 
      0.7
    );

   const assistantReply = (response as any).content || 'Processado.';

    // ─── 7. SALVAMENTO NO HISTÓRICO UNIFICADO (BRAIN) ───
    try {
      // Se for uma mensagem muito curta/casual, entra como noise, senão como info
      const cat = message.length < 15 ? 'noise' : 'info';

      await supabase.from('brain').insert([
        {
          user_id: Number(user.id),
          session_id: sessionId,
          content: message,
          category: cat,
          project_tag: 'geral',
          metadata: { role: 'user', contexts: contexts }
        },
        {
          user_id: Number(user.id),
          session_id: sessionId,
          content: assistantReply,
          category: cat,
          project_tag: 'geral',
          metadata: { role: 'assistant', model: resolvedModel }
        }
      ]);
    } catch (dbErr) {
      console.error('[DB] Erro ao salvar no brain:', dbErr);
    }
    // ──────────────────────────────────────────────────────────

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