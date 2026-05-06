// app/api/chat/route.ts — V11.8.0 (RIGOR TOTAL: Anti-Collision History + OpenRouter Fix)
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
import { executeTool } from '@/lib/chat/tools-executor';
import OpenAI from 'openai';
import { extractAndSummarize } from '@/lib/extractor'; 
import { buildDynamicContext } from '@/lib/chat/context-builder';

export const maxDuration = 60;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY_1 });

const MAX_MSG_CHARS = 800;
const FAMILY_DATE_SIGNALS = [/aniversário/i, /casamento/i, /filh[oa]/i, /esposa|marido/i, /natal/i];

async function generateTTS(text: string, voice: string = 'alloy'): Promise<string | null> {
  try {
    const cleanText = text.replace(/[*#_~]/g, '').trim();
    if (!cleanText) return null;
    const mp3 = await openai.audio.speech.create({ model: "tts-1", voice: voice as any, input: cleanText });
    return Buffer.from(await mp3.arrayBuffer()).toString('base64');
  } catch (e) { return null; }
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    const body = await (req.headers.get('content-type')?.includes('multipart') ? req.formData() : req.json());
    const message = (body instanceof FormData ? body.get('message') as string : body.message) || '';
    const userEmail = body instanceof FormData ? body.get('userEmail') as string : body.userEmail;
    const speak = body instanceof FormData ? body.get('speak') === 'true' : !!body.speak;
    const incomingSessionId = body instanceof FormData ? (body.get('sessionId') as string | null) : (body.sessionId as string | null);
    const userLocation = body instanceof FormData ? null : body.location;

    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!user) return NextResponse.json({ error: 'Auth failed' }, { status: 401 });
    const sessionId = incomingSessionId || await getOrCreateSession(String(user.id));

    // 1. GOD RPC: CONSOLIDAÇÃO
    const { data: masterContext, error: rpcError } = await supabase.rpc('get_consolidated_context', { 
        p_user_id: user.id, p_session_id: sessionId 
    });
    if (rpcError) console.error('[RPC FATAL ERROR]:', rpcError.message);

    // 2. RECENT HISTORY (FIX: Alternância de Roles + Proteção contra vácuo)
    const rawHistory = masterContext?.history || [];
    const recentHistory: any[] = [];
    for (const row of [...rawHistory].reverse()) {
      const uMsg = (row.content || '').trim();
      const aRep = (row.metadata?.ai_reply || '').trim();
      // Somente adiciona se houver conteúdo real, garantindo User -> Assistant
      if (uMsg.length > 2) {
        recentHistory.push({ role: 'user', content: uMsg.slice(0, MAX_MSG_CHARS) });
      }
      if (aRep.length > 2) {
        recentHistory.push({ role: 'assistant', content: aRep.slice(0, MAX_MSG_CHARS) });
      }
    }

    // 3. DEDUPLICAÇÃO
    const timeSlot = Math.floor(Date.now() / 10000);
    const requestSignature = `${sessionId}_${Buffer.from(message.substring(0, 50)).toString('base64')}_${timeSlot}`;
    const dedupKey = `chat_dedup:${requestSignature}`;
    const replyKey = `chat_reply:${requestSignature}`;
    const isFirst = await redis.set(dedupKey, '1', { nx: true, ex: 30 });

    if (!isFirst) {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const cached = await redis.get<string>(replyKey);
        if (cached) return NextResponse.json({ reply: cached, ok: true, sessionId, performance: '0ms (dedup)' });
      }
    }

    // 4. PROCESSAMENTO PARALELO
    const [queryEmbedding, isStressed, contexts] = await Promise.all([
      getCachedEmbedding(message).catch(() => null),
      llmGateway.isOverloaded(),
      classifyContextWithL4(message, String(user.id)),
    ]);

    const memory = await MemoryManager.read({
      userId: String(user.id),
      authUserId: user.auth_user_id,
      sessionId,
      message,
      contexts,
      emotionalScore: 0,
      authorName: user.nickname,
      assistantName: user.assistant_name,
      queryEmbedding,
      masterContext 
    });

    const emotional = await computeEmotionalScore(message, String(user.id), memory.hd.memories ?? [], memory.ram.ramBlock ?? '');

    const { contextBlocks, activeTools, resolvedModel } = await loadActiveModules(
      { userId: String(user.id), authUserId: user.auth_user_id, message, contexts, emotionalScore: emotional.score, location: userLocation },
      user.plan || 'free',
      masterContext 
    );

    // 5. RADAR DE AFETO (RIGOR MANTIDO)
    let filteredL3 = memory.l3.content;
    const todayCheck = new Date();
    const isHighAlertMonth = todayCheck.getMonth() === 4 || todayCheck.getMonth() === 7;
    const historyText = rawHistory.map((h: any) => h.content).join(' ');

    if (!isHighAlertMonth && !FAMILY_DATE_SIGNALS.some(p => p.test(historyText + message))) {
      filteredL3 = filteredL3.replace(/##\s*(datas?|aniversário|famil[íi]a|cônjuge|esposa|filho)[^\n]*\n[\s\S]*?(?=##|$)/gi, '').trim();
    }

    // 6. COMPOSIÇÃO DE PROMPT
    const nowSP = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const basePrompt = composeSystemPrompt({
      assistantName: user.assistant_name,
      authorName: user.nickname,
      isLikelyNoise: message.length < 15,
      isSystemStressed: isStressed,
      emotionalScore: emotional.score,
      detectedContexts: contexts,
      contextBlocks,
      memoryBlocks: {
        truncatedL3: filteredL3.slice(0, 3000),
        truncatedHd: memory.hd.block.slice(0, 4000),
        truncatedEvents: memory.events.block.slice(0, 2000),
        relationship: memory.relationship.block.slice(0, 2000),
        topics: memory.topics.relatedTopicsBlock,
      },
      canonicalDateTimeBlock: nowSP.toLocaleString('pt-BR'),
      canonicalDateISO: nowSP.toISOString().split('T')[0],
      systemWarning: '',
      intent: 'personal',
      dynamicGuidelines: (masterContext?.guidelines || []).map((g: any) => `- ${g.content}`).join('\n'),
    });

    const { contextText, activeTools: dynamicTools } = await buildDynamicContext({
      userId: String(user.id), authUserId: user.auth_user_id, message, location: userLocation, contexts, emotionalScore: emotional.score, masterContext
    });

    const coreTools = ['salvar_evento', 'consultar_agenda', 'create_reminder', 'searchWeb', 'buscar_memoria_longa', 'consultar_lembretes', 'adicionar_diretriz_dinamica'];
    const toolsHabilitadas = ALL_TOOLS.filter(t => coreTools.includes(t.function.name) || activeTools.includes(t.function.name) || dynamicTools.includes(t.function.name));

    const systemPrompt = `[HORA]: ${nowSP.toLocaleString('pt-BR')}\n${contextText}\n${(masterContext?.reminders?.length > 0) ? `[ALERTA]: Pendências: ${masterContext.reminders.map((r: any) => r.title).join(', ')}` : ''}\n---\n${basePrompt}`;

    // 7. EXECUÇÃO LLM (FIX: Verificação de Model)
    const finalModel = resolvedModel || 'google/gemini-2.0-flash-001';
    const conversationMessages = [{ role: 'system', content: systemPrompt }, ...recentHistory, { role: 'user', content: message }];
    
    const firstResponse = await callOpenRouterWithPriority(1, 'never', requestSignature, conversationMessages, toolsHabilitadas, finalModel, 0.7);

    let assistantReply = firstResponse.content || "Comando processado.";

    if (firstResponse.toolCalls && firstResponse.toolCalls.length > 0) {
      const toolResults = await Promise.all(firstResponse.toolCalls.map(async (tc) => ({ tc, result: await executeTool(tc, user.auth_user_id, String(user.id)) })));
      const secondResponse = await callOpenRouterWithPriority(1, 'never', `${requestSignature}_synth`, [
        ...conversationMessages,
        { role: 'assistant', content: firstResponse.content || null, tool_calls: firstResponse.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } })) },
        ...toolResults.map(({ tc, result }) => ({ role: 'tool', tool_call_id: tc.id, content: result }))
      ], [], finalModel, 0.7);
      assistantReply = secondResponse.content || assistantReply;
    }

    // 8. FINALIZAÇÃO
    await redis.set(replyKey, assistantReply, { ex: 30 }).catch(() => {});
    supabase.from('brain').insert({
      user_id: Number(user.id), session_id: sessionId, content: message, category: message.length < 15 ? 'noise' : 'info',
      metadata: { role: 'user', ai_reply: assistantReply, contexts, model: finalModel }
    }).then(() => {});

    extractAndSummarize(String(user.id), user.nickname || 'Usuário', message, assistantReply).catch(() => {});

    return NextResponse.json({
      reply: assistantReply,
      audioBase64: speak ? await generateTTS(assistantReply, user.preferred_voice || 'alloy') : null,
      ok: true, sessionId, performance: `${Date.now() - startTime}ms`,
    });

  } catch (e: any) {
    console.error('[FATAL ERROR]:', e);
    return NextResponse.json({ error: 'Erro no motor do Jarvis.' }, { status: 500 });
  }
}
