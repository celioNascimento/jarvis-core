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
    const memory = await MemoryManager.read({ userId: String(user.id), authUserId: user.auth_user_id, sessionId, message, contexts, emotionalScore: emotional.score, authorName: user.nickname, assistantName: user.assistant_name });
    
    const systemPrompt = composeSystemPrompt({
      assistantName: user.assistant_name, authorName: user.nickname, isLikelyNoise: message.length < 15,
      isSystemStressed: isStressed, emotionalScore: emotional.score, detectedContexts: contexts,
      contextBlocks, memoryBlocks: { /* lógica de truncagem aqui */ },
      canonicalDateTimeBlock: new Date().toLocaleString('pt-BR'),
      canonicalDateISO: new Date().toISOString(),
      systemWarning: '', intent: 'personal', dynamicGuidelines: ''
    });

    // 5. Filtragem de Ferramentas (Security Layer)
    const coreTools = ['salvar_evento', 'create_reminder', 'searchWeb'];
    const toolsHabilitadas = ALL_TOOLS.filter(t => coreTools.includes(t.function.name) || activeTools.includes(t.function.name));

    // 6. Execução via Gateway
    const response = await callOpenRouterWithPriority(1, 'never', crypto.randomUUID(), [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ], toolsHabilitadas, resolvedModel, 0.7);

    return NextResponse.json({ 
      reply: (response as any).content || 'Processado.', 
      ok: true,
      performance: `${Date.now() - startTime}ms`
    });

  } catch (e: any) {
    console.error('[FATAL]', e);
    return NextResponse.json({ error: 'Erro interno no motor.' }, { status: 500 });
  }
}
