// app/api/chat/route.ts — V8.18.1 (Radar de Afeto + Diretrizes Dinâmicas + Extrator de Dados)
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
import { getUserFromToken } from '@/lib/auth';
import { extractAndSummarize } from '@/lib/extractor'; // ✅ IMPORT DO EXTRATOR ADICIONADO

export const maxDuration = 60;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY_1 });

// ─── Constantes Globais ──────────────────────────────────────────────────────

const MAX_HISTORY_TURNS = 6;
const MAX_MSG_CHARS = 800;

const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /filh[oa]/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

// ─── Histórico da sessão ─────────────────────────────────────────────────────

async function getRecentMessages(
  sessionId: string,
  userId: string,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  try {
    const { data } = await supabase
      .from('brain')
      .select('content, metadata, created_at')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .neq('category', 'archived')
      .order('created_at', { ascending: false })
      .limit(MAX_HISTORY_TURNS);

    if (!data || data.length === 0) return [];

    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const row of [...data].reverse()) {
      const userMsg = (row.content || '').trim();
      const aiReply = (row.metadata?.ai_reply || '').trim();

      if (userMsg.length > 3) {
        turns.push({ role: 'user', content: userMsg.slice(0, MAX_MSG_CHARS) });
      }
      if (aiReply.length > 3) {
        turns.push({ role: 'assistant', content: aiReply.slice(0, MAX_MSG_CHARS) });
      }
    }

    while (turns.length > 0 && turns[turns.length - 1].role === 'user') {
      turns.pop();
    }

    return turns;
  } catch (e) {
    console.error('[History] Erro ao buscar histórico:', e);
    return [];
  }
}

// ─── Gerador de Voz (OpenAI TTS) ─────────────────────────────────────────────
async function generateTTS(text: string, voice: string = 'alloy'): Promise<string | null> {
  try {
    const cleanText = text.replace(/[*#_~]/g, '').trim();
    if (!cleanText) return null;

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: voice as any,
      input: cleanText,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    return buffer.toString('base64');
  } catch (e) {
    console.error('[TTS] Erro:', e);
    return null;
  }
}

// ─── Handler principal ────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.split(' ')[1];
  const startTime = Date.now();
  try {
    const body = await (req.headers.get('content-type')?.includes('multipart')
      ? req.formData()
      : req.json());

    const message = body instanceof FormData ? body.get('message') as string : body.message;
    const userEmail = body instanceof FormData ? body.get('userEmail') as string : body.userEmail;
    const speak = body instanceof FormData ? body.get('speak') === 'true' : !!body.speak;
    const incomingSessionId = body instanceof FormData
      ? (body.get('sessionId') as string | null)
      : (body.sessionId as string | null);

    // 1. Resolve Usuário (AQUI JÁ TEMOS O BIGINT EM user.id)
    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!user) return NextResponse.json({ error: 'Auth failed' }, { status: 401 });

    const sessionId = incomingSessionId || await getOrCreateSession(String(user.id));

    // ── BUSCA DIRETRIZES DINÂMICAS ───────────────────────────────────────────
    const { data: guidelines } = await supabase
      .schema('jarvis')
      .from('dynamic_guidelines')
      .select('content')
      .eq('user_id', user.id)
      .eq('active', true);

    const dynamicGuidelinesBlock = guidelines?.map(g => `- ${g.content}`).join('\n') || '';

    // ── DEDUPLICAÇÃO GLOBAL ──────────────────────────────────────────────────
    const timeSlot = Math.floor(Date.now() / 10000);
    const requestSignature = `${sessionId}_${Buffer.from(message.substring(0, 50)).toString('base64')}_${timeSlot}`;
    const dedupKey = `chat_dedup:${requestSignature}`;
    const replyKey = `chat_reply:${requestSignature}`;

    const isFirst = await redis.set(dedupKey, '1', { nx: true, ex: 30 });

    if (!isFirst) {
      console.warn('[Dedup] Retry detectado, aguardando reply cacheado...');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const cached = await redis.get<string>(replyKey);
        if (cached) {
          console.log('[Dedup] Reply cacheado encontrado, retornando.');
          return NextResponse.json({ reply: cached, ok: true, sessionId, performance: '0ms (dedup)' });
        }
      }
      console.warn('[Dedup] Timeout esperando reply. Deixando passar.');
    }

    // ── FASE 1: Paralelo ─────────────────────────────────────────────────────
    const [queryEmbedding, recentHistory, isStressed, contexts] = await Promise.all([
      getCachedEmbedding(message).catch(() => null),
      getRecentMessages(sessionId, String(user.id)),
      llmGateway.isOverloaded(),
      classifyContextWithL4(message, String(user.id)),
    ]);

    // ── FASE 2: Memória carregada ──────────────────────────
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
    });

    // ── FASE 3: Score emocional ─────────────────────────────
    const emotional = await computeEmotionalScore(
      message,
      String(user.id),
      memory.hd.memories ?? [],
      memory.ram.ramBlock ?? '',
    );

    // ── Carregamento Modular ─────────────────────────────────────────────────
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

    // ── Guard L3 (Radar de Afeto) ─────────────────
    let filteredL3 = memory.l3.content;
    const todayCheck = new Date();
    const isMay = todayCheck.getMonth() === 4;
    const isAugust = todayCheck.getMonth() === 7;
    const isHighAlertMonth = isMay || isAugust;

    if (recentHistory.length > 0 || isHighAlertMonth) {
      const recentText = recentHistory.map(m => m.content).join(' ');
      const historyHasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(recentText));
      const messageHasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(message));

      if (historyHasFamilySignal || messageHasFamilySignal || isHighAlertMonth) {
        filteredL3 = memory.l3.content;
      } else {
        filteredL3 = filteredL3
          .replace(/##\s*(datas?|aniversário|comemoração|evento importante)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
          .replace(/##\s*(famil[íi]a|cônjuge|esposa|marido|filho|parente)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
          .trim();
      }
    }

    // 5. Composição do Prompt
    const coreTools = [
      'salvar_evento', 
      'consultar_agenda', 
      'create_reminder', 
      'searchWeb', 
      'buscar_memoria_longa', 
      'adicionar_diretriz_dinamica'
    ];

    const toolsHabilitadas = ALL_TOOLS.filter(t =>
      coreTools.includes(t.function.name) || activeTools.includes(t.function.name)
    );
    

    const nowSP = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const diasDaSemana = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    const nomeDia = diasDaSemana[nowSP.getDay()];
    const dataHoraSP = nowSP.toLocaleString('pt-BR');
    const dataIsoSP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

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
      canonicalDateTimeBlock: dataHoraSP,
      canonicalDateISO: dataIsoSP,
      systemWarning: '',
      intent: 'personal',
      dynamicGuidelines: dynamicGuidelinesBlock,
    });


    const systemPrompt = `[RELÓGIO DO SISTEMA - LEI ABSOLUTA]
Hoje é ${nomeDia}, ${dataHoraSP}. 
---
[DIRETRIZES DE EXECUÇÃO E FERRAMENTAS - PRIORIDADE MÁXIMA]
1. AGENDA E EVENTOS (FOCO NA TABELA 'EVENTS'): 
   - PRIORIDADE INTERNA: Para qualquer compromisso ou evento, use OBRIGATORIAMENTE a ferramenta 'salvar_evento'. Ela registra os dados na tabela 'events' do nosso banco de dados (Supabase), que é a sua fonte primária de verdade.
   - SINCRONIZAÇÃO EXTERNA: Use a ferramenta 'criar_evento_agenda' (Google) apenas como um espelho opcional. Se houver erro de conexão com o Google, informe ao usuário que o evento foi "Salvo localmente na agenda do app", mas que a sincronização externa falhou.
   - CONSULTA: Ao consultar a agenda, priorize os dados retornados da 'Agenda Lev' (tabela events).
   
2. LISTAS E COMPRAS: Extração em background com confirmação detalhada.

3. BRAINSTORMING: Atue como especialista, faça perguntas, não seja apenas um anotador.

4. COMUNICAÇÃO: Proibido responder "Feito" ou "Anotado". Descreva a ação.
---
${basePrompt}`;


    // 6. Primeira chamada ao LLM
    const conversationMessages: any[] = [
      { role: 'system', content: systemPrompt },
      ...recentHistory,
      { role: 'user', content: message },
    ];

    const firstResponse = await callOpenRouterWithPriority(
      1, 'never', requestSignature,
      conversationMessages,
      toolsHabilitadas,
      resolvedModel,
      0.7,
    );

    let assistantReply: string;

    // 7. Loop de execução de tools
    if (firstResponse.toolCalls && firstResponse.toolCalls.length > 0) {
      console.log(`[Tools] ${firstResponse.toolCalls.length} tool(s) detectada(s)`);

      const toolResults = await Promise.all(
        firstResponse.toolCalls.map(async (toolCall) => {
          const result = await executeTool(toolCall, user.auth_user_id, String(user.id));
          return { toolCall, result };
        })
      );

      const messagesWithToolResults: any[] = [
        ...conversationMessages,
        {
          role: 'assistant',
          content: firstResponse.content || null,
          tool_calls: firstResponse.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        },
        ...toolResults.map(({ toolCall, result }) => ({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        })),
      ];

      const secondResponse = await callOpenRouterWithPriority(
        1, 'never', `${requestSignature}_tool_synthesis`,
        messagesWithToolResults,
        [],
        resolvedModel,
        0.7,
      );

      assistantReply = secondResponse.content || "Comando executado com sucesso, Célio. As informações já foram processadas e registradas no sistema.";

    } else {

      assistantReply = firstResponse.content || "Entendido. Processei a informação, mas não consegui gerar um resumo textual. Pode confirmar se precisa de mais algum detalhe?";
    }

    await redis.set(replyKey, assistantReply, { ex: 30 }).catch(() => { });

    // 8. Salvamento no brain
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
          contexts,
          model: resolvedModel,
        },
      });
    } catch (dbErr) {
      console.error('[DB] Erro ao salvar no brain:', dbErr);
    }

    const userVoice = user.preferred_voice || 'alloy';
    const audioBase64 = speak ? await generateTTS(assistantReply, userVoice) : null;

    // ── ✅ 10. EXTRAÇÃO DE DADOS EM BACKGROUND (A MÁGICA ACONTECE AQUI) ──
    // O sistema dispara o extrator em segundo plano para anotar as informações (Compras, Perfil, Projetos)
    // Usamos String(user.id) garantindo que o BigInt correto seja passado.
   await extractAndSummarize(String(user.id), user.nickname || 'Usuário', message, assistantReply);

    // 11. RESPOSTA FINAL
    return NextResponse.json({
      reply: assistantReply,
      audioBase64,
      ok: true,
      sessionId,
      performance: `${Date.now() - startTime}ms`,
    });

  } catch (e: any) {
    console.error('[FATAL]', e);
    return NextResponse.json(
      { error: 'Erro interno no motor do Jarvis.' },
      { status: 500 }
    );
  }
}
