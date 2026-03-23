// app/api/chat/route.ts
// Canal web/app para o motor Lev — substitui o webhook Telegram para o lev-app
// Suporta streaming SSE (Server-Sent Events)

import {
  supabase,
  generateEmbedding,
  reinforceMemory,
  getOrCreateSession,
  setPendingQuestion,
  clearPendingQuestion,
} from '@/lib/jarvis';
import {
  buildRecommendationsBlock,
  buildTopicBlock,
  extractRecomendacao,
} from '@/lib/extractor-jobs';
import {
  extractDiary,
  extractGoal,
  buildDiaryGoalsBlock,
  updateGoalProgress,
} from '@/lib/diary';
import { buildGapsBlock } from '@/lib/extractor';
import { getMicrosoftCalendarContext } from '@/lib/microsoft';
import { getGoogleContext } from '@/lib/google';
import { upsertEvent } from '@/lib/extractor-jobs';

export const maxDuration = 10; // Vercel Hobby limit

// ── Tipos ────────────────────────────────────────────────────────────────────
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type ContextType =
  | 'agenda' | 'projeto' | 'familia' | 'emocao' | 'diario' | 'meta'
  | 'saude' | 'recomendacao' | 'evento' | 'rotina' | 'preferencia'
  | 'alias' | 'email' | 'casual';

// ── Helpers reutilizados do webhook ──────────────────────────────────────────
function classifyContext(text: string): ContextType[] {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const rules: Array<[RegExp, ContextType]> = [
    [/diario|diário|hoje foi|hoje ta|hoje está|acordei|dormi|meu dia|reflexao|gratid/i, 'diario'],
    [/meta|objetivo|quero (conseguir|fazer|terminar|lancar|comecar)|prazo|progresso/i, 'meta'],
    [/reuniao|reunião|consulta|compromisso|agend|horario|às \d|as \d{1,2}h/i, 'agenda'],
    [/projeto|app|aplicativo|sistema|api|deploy|feature|sprint|mvp/i, 'projeto'],
    [/filho|filha|esposa|marido|mae|mãe|pai|família|casamento/i, 'familia'],
    [/medic|médic|saude|saúde|exame|remedio|hospital/i, 'saude'],
    [/sinto|estou (triste|feliz|ansioso|cansado|animado|frustrado)|me sinto|to mal|tô mal/i, 'emocao'],
    [/email|e-mail|inbox|mensagem do/i, 'email'],
    [/indica|recomend|sugere|onde posso|tem algum|restaurante/i, 'recomendacao'],
    [/aniversario|aniversário|natal|pascoa|páscoa|ano novo/i, 'evento'],
    [/acordo|academia|treino|trabalho as|rotina|horario de/i, 'rotina'],
    [/gosto de|nao gosto|prefiro|adoro|odeio/i, 'preferencia'],
    [/quando falo em|apelido|alias/i, 'alias'],
  ];
  const detected: ContextType[] = [];
  for (const [rx, ctx] of rules) {
    if (rx.test(t)) detected.push(ctx);
  }
  return detected.length > 0 ? detected : ['casual'];
}

function routeModel(contexts: ContextType[]): string {
  const complex: ContextType[] = ['agenda', 'projeto', 'familia', 'emocao', 'diario', 'meta', 'saude'];
  return contexts.some(c => complex.includes(c))
    ? 'anthropic/claude-sonnet-4-5'
    : 'google/gemini-2.0-flash-001';
}

function getTemperature(contexts: ContextType[]): number {
  if (contexts.some(c => ['emocao', 'diario'].includes(c))) return 0.9;
  if (contexts.some(c => ['casual', 'projeto', 'familia', 'meta'].includes(c))) return 0.7;
  if (contexts.some(c => ['rotina', 'alias', 'preferencia', 'recomendacao'].includes(c))) return 0.5;
  return 0.3;
}

// ── Stream SSE helper ─────────────────────────────────────────────────────────
async function* streamOpenRouter(
  messages: ChatMessage[],
  model: string,
  temperature: number,
  signal: AbortSignal
): AsyncGenerator<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: 800, temperature, stream: true, messages }),
  });

  if (!res.ok || !res.body) throw new Error(`OpenRouter ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {}
    }
  }
}

// ── POST handler ──────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  try {
    // ── 1. Parse body ────────────────────────────────────────────────────────
    console.log('[chat] 1. parse body');
    const { message, userId, sessionId: clientSessionId, userEmail } = await req.json();
    console.log('[chat] 2. message:', message?.slice(0, 30), '| email:', userEmail, '| userId:', userId);

    if (!message || !userEmail) {
      return new Response(
        JSON.stringify({ error: 'message e userEmail obrigatórios' }),
        { status: 400 }
      );
    }

    // ── 2. Busca usuário por email ───────────────────────────────────────────
    // CORREÇÃO: a tabela jarvis.users tem campo `email`, não telegram_chat_id
    console.log('[chat] 3. buscando usuário por email:', userEmail);
    const { data: userProfile, error: userError } = await supabase
      .from('users')
      .select('id, nickname, current_context, assistant_name, timezone')
      .eq('email', userEmail)
      .maybeSingle();

    console.log('[chat] 4. userProfile id:', userProfile?.id, '| erro:', userError?.message);

    if (userError) {
      console.error('[chat] Erro ao buscar usuário:', userError);
      return new Response(JSON.stringify({ error: 'Erro ao buscar usuário' }), { status: 500 });
    }

    if (!userProfile) {
      return new Response(
        JSON.stringify({ error: 'Usuário não encontrado. Conta não vinculada.' }),
        { status: 404 }
      );
    }

    const userId_ = String(userProfile.id); // bigint → string para todas as queries
    console.log('[chat] 5. userId_:', userId_);

    const authorName    = userProfile.nickname    || 'você';
    const assistantName = userProfile.assistant_name || 'Lev';
    const userTimezone  = userProfile.timezone    || 'America/Sao_Paulo';

    // ── 3. Sessão ────────────────────────────────────────────────────────────
    console.log('[chat] 6. getOrCreateSession');
    const sessionId = clientSessionId || (await getOrCreateSession(userId_));
    console.log('[chat] 7. sessionId:', sessionId);

    // ── 4. Classificação de contexto ─────────────────────────────────────────
    console.log('[chat] 8. classifyContext');
    const contexts    = classifyContext(message);
    const model       = routeModel(contexts);
    const temperature = getTemperature(contexts);
    console.log('[chat] 9. contexts:', contexts, '| model:', model);

    const needsCalendar = contexts.some(c => ['agenda', 'evento', 'familia'].includes(c));
    const needsTopics   = contexts.some(c => ['saude', 'projeto', 'familia', 'casual', 'rotina'].includes(c));
    const needsDiary    = contexts.some(c => ['diario', 'meta', 'emocao', 'casual'].includes(c));
    const needsRecs     = contexts.some(c => ['recomendacao', 'casual'].includes(c));

    // ── 5. Cargas paralelas ──────────────────────────────────────────────────
    console.log('[chat] 10. iniciando Promise.all blocos contextuais');
    const [
      googleCtx,
      msCtx,
      topicBlock,
      diaryBlock,
      gapsBlock,
    ] = await Promise.all([
      needsCalendar ? getGoogleContext().catch((e) => { console.error('[chat] googleCtx erro:', e.message); return null; })            : Promise.resolve(null),
      needsCalendar ? getMicrosoftCalendarContext().catch((e) => { console.error('[chat] msCtx erro:', e.message); return null; })     : Promise.resolve(null),
      needsTopics   ? buildTopicBlock(userId_, message).catch((e) => { console.error('[chat] topicBlock erro:', e.message); return ''; })  : Promise.resolve(''),
      needsDiary    ? buildDiaryGoalsBlock(userId_).catch((e) => { console.error('[chat] diaryBlock erro:', e.message); return ''; })   : Promise.resolve(''),
      buildGapsBlock(userId_, message).catch((e) => { console.error('[chat] gapsBlock erro:', e.message); return ''; }),
    ]);
    console.log('[chat] 11. Promise.all concluído');

    const recsBlock = needsRecs
      ? await buildRecommendationsBlock(userId_, message).catch((e) => { console.error('[chat] recsBlock erro:', e.message); return ''; })
      : '';

    // ── 6. RAM (histórico recente da sessão) ─────────────────────────────────
    console.log('[chat] 12. buscando RAM (brain)');
    const { data: history } = await supabase
      .from('brain').select('content, metadata')
      .eq('user_id', userId_).eq('session_id', sessionId)
      .neq('category', 'archived')
      .order('created_at', { ascending: false }).limit(8);
    console.log('[chat] 13. history length:', history?.length ?? 0);

    const ramBlock = history && history.length >= 2
      ? [...history].reverse().map((h: any) => {
          const ai = (h.metadata?.ai_reply || '').replace(/\[.*?\]/g, '').trim();
          return `${authorName}: ${h.content}\n${assistantName}: ${ai}`;
        }).join('\n\n')
      : '';

    // ── 7. HD vetorial ───────────────────────────────────────────────────────
    console.log('[chat] 14. generateEmbedding');
    const embedding = await generateEmbedding(message);
    console.log('[chat] 15. embedding:', embedding ? `[${embedding.length} dims]` : 'null');

    let hdBlock = '';
    let hdIds: string[] = [];
    if (embedding) {
      console.log('[chat] 16. match_memories rpc');
      const { data: search } = await supabase.rpc('match_memories', {
        query_embedding: embedding, match_threshold: 0.4, match_count: 3,
      }) as { data: any[] | null };
      console.log('[chat] 17. memories encontradas:', search?.length ?? 0);
      if (search?.length) {
        hdBlock = search.filter(r => !r.summary.startsWith('[CINZA]')).map(r => r.summary).join('\n---\n');
        hdIds   = search.map(r => r.id);
      }
    }

    // ── 8. Monta system prompt ───────────────────────────────────────────────
    console.log('[chat] 18. montando system prompt');
    const currentContextL3 = userProfile.current_context || '';
    const fusoHorario = new Date().toLocaleString('pt-BR', { timeZone: userTimezone });

    const systemPrompt = `
Você é ${assistantName}, assistente pessoal de ${authorName}.
Data/hora: ${fusoHorario} 

${googleCtx  ? `[AGENDA GOOGLE]\n${googleCtx}`    : ''}
${msCtx      ? `[AGENDA OUTLOOK]\n${msCtx}`        : ''}
${currentContextL3 ? `[QUEM É ${authorName.toUpperCase()}]\n${currentContextL3}` : ''}
${recsBlock  ? recsBlock  : ''}
${topicBlock ? topicBlock : ''}
${diaryBlock ? diaryBlock : ''}
${hdBlock    ? `[MEMÓRIAS]\n${hdBlock}` : ''}
${ramBlock   ? `[CONVERSA RECENTE]\n${ramBlock}` : ''}
${gapsBlock  ? gapsBlock  : ''}

REGRAS:
1. Responda O QUE FOI PERGUNTADO. Nunca mude de assunto sem motivo.
2. Tom: amigo de longa data — direto, humano, sem formalidades.
3. PROIBIDO: "Anotado!", "Registrado!", "Guardei aqui!" — jamais.
4. NUNCA comece com "Considerando que", "Com base no seu histórico".
5. Gatilhos invisíveis (não aparecem na resposta):
   [SALVAR_EVENTO: título | YYYY-MM-DD | alta|media|baixa | true|false | recurring_annual|deadline|one_time]
   [ATUALIZAR_META: título | progresso | etapa_opcional]
6. Ao final: [CLASSE: info] ou [CLASSE: noise]
`.trim();

    const conversationMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...(history || []).reverse().flatMap((h: any): ChatMessage[] => [
        { role: 'user',      content: h.content },
        { role: 'assistant', content: (h.metadata?.ai_reply || '').replace(/\[.*?\]/g, '').trim() },
      ]),
      { role: 'user', content: message },
    ];

    // ── 9. Streaming response ────────────────────────────────────────────────
    console.log('[chat] 19. iniciando stream OpenRouter com model:', model);
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 9000);

    const encoder = new TextEncoder();
    let fullReply = '';

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of streamOpenRouter(
            conversationMessages, model, temperature, abortController.signal
          )) {
            fullReply += chunk;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
          }
        } catch (e: any) {
          if (e.name !== 'AbortError') {
            console.error('[chat/stream] Erro no stream:', e.message);
          }
        } finally {
          clearTimeout(timeoutId);
          console.log('[chat] 20. stream concluído, fullReply length:', fullReply.length);

          const categoryMatch = fullReply.match(/\[CLASSE:\s*(\w+)\]/i);
          const category      = categoryMatch?.[1]?.toLowerCase() || 'info';
          let cleanReply      = fullReply.replace(/\[CLASSE:\s*\w+\]/gi, '').trim();

          // Processa gatilho de evento
          const eventRegex = /\[SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\s*\|\s*(recurring_annual|deadline|one_time)\]/gi;
          for (const m of Array.from(cleanReply.matchAll(eventRegex)) as any[]) {
            await upsertEvent(userId_, {
              title: m[1].trim(), event_date: m[2], priority: m[3],
              is_recurring: m[4] === 'true', decay_type: m[5],
              category: 'personal', emotional_weight: m[3] === 'alta' ? 0.9 : 0.5,
            }).catch(() => {});
            cleanReply = cleanReply.replace(m[0], '').trim();
          }

          // Processa atualização de meta
          const goalMatch = cleanReply.match(/\[ATUALIZAR_META:\s*([^|]+)\|\s*(\d+)(?:\|\s*([^\]]+))?\]/i);
          if (goalMatch) {
            await updateGoalProgress(userId_, goalMatch[1].trim(), parseInt(goalMatch[2]), goalMatch[3]?.trim()).catch(() => {});
            cleanReply = cleanReply.replace(goalMatch[0], '').trim();
          }

          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, reply: cleanReply })}\n\n`));
          controller.close();

          // Background: persiste + extratores
          Promise.all([
            supabase.from('brain').insert([{
              content: message, category, user_id: userId_, session_id: sessionId,
              embedding,
              metadata: {
                ai_reply: cleanReply, user: authorName,
                model_used: model, contexts_detected: contexts,
              },
            }]),
            ...hdIds.map(id => reinforceMemory(id)),
            extractRecomendacao(userId_, message, cleanReply).catch(() => {}),
            extractDiary(userId_, message, 'anytime').catch(() => {}),
            extractGoal(userId_, message).catch(() => {}),
          ]).catch(e => console.error('[chat/background] Erro:', e));
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
      },
    });

  } catch (error: any) {
    console.error('[chat] ERRO DETALHADO:', error.message);
    console.error('[chat] STACK:', error.stack?.slice(0, 800));
    return new Response(JSON.stringify({ error: 'Erro interno' }), { status: 500 });
  }
}