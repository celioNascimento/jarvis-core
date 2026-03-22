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
    const { message, userId, sessionId: clientSessionId, userEmail } = await req.json();

    if (!message || !userId) {
      return new Response(JSON.stringify({ error: 'message e userId obrigatórios' }), { status: 400 });
    }

    // Busca usuário — tenta pelo telegram_chat_id primeiro, depois pelo email
    // userId do app é o UUID do Supabase Auth, não o telegram_chat_id
    let userProfile: any = null;
    let resolvedUserId: string = userId;

    // Tenta encontrar por email (mais confiável para usuários do app)
    if (userEmail) {
      const { data: byEmail } = await supabase
        .from('users')
        .select('id, nickname, current_context, pending_question, assistant_name, timezone')
        .eq('telegram_chat_id', userId)
        .maybeSingle();

      if (byEmail) {
        userProfile = byEmail;
        resolvedUserId = String(byEmail.id);
      } else {
        // Usuário novo do app — busca na tabela auth do Supabase pelo email
        // e tenta achar o registro correspondente na jarvis.users
        const { data: byTelegramNull } = await supabase
          .from('users')
          .select('id, nickname, current_context, pending_question, assistant_name, timezone')
          .is('telegram_chat_id', null)
          .limit(1)
          .maybeSingle();

        // Se não achou, cria entrada mínima para o usuário do app
        if (!byTelegramNull) {
          // Extrai nome do email
          const nameFromEmail = userEmail.split('@')[0].replace(/[._]/g, ' ');
          const { data: newUser } = await supabase
            .from('users')
            .insert({
              id: Date.now(), // id bigint único baseado em timestamp
              name: nameFromEmail,
              nickname: nameFromEmail,
              telegram_chat_id: userId, // guarda o auth UUID aqui para lookup futuro
            })
            .select('id, nickname, current_context, pending_question, assistant_name, timezone')
            .single();
          userProfile = newUser;
          resolvedUserId = String(newUser?.id);
        }
      }
    }

    // Fallback: tenta direto pelo id como string no telegram_chat_id
    if (!userProfile) {
      const { data: byTelegramId } = await supabase
        .from('users')
        .select('id, nickname, current_context, pending_question, assistant_name, timezone')
        .eq('telegram_chat_id', userId)
        .maybeSingle();

      if (byTelegramId) {
        userProfile = byTelegramId;
        resolvedUserId = String(byTelegramId.id);
      }
    }

    if (!userProfile) {
      return new Response(JSON.stringify({ error: 'Usuário não encontrado. Configure sua conta pelo Telegram primeiro.' }), { status: 404 });
    }

    const userId_ = resolvedUserId;

    const authorName    = userProfile.nickname || 'você';
    const assistantName = userProfile.assistant_name || 'Lev';
    const userTimezone  = userProfile.timezone || 'America/Sao_Paulo';

    // Sessão
    const sessionId = clientSessionId || (await getOrCreateSession(userId_));

    // Classificação de contexto
    const contexts    = classifyContext(message);
    const model       = routeModel(contexts);
    const temperature = getTemperature(contexts);

    const needsCalendar = contexts.some(c => ['agenda', 'evento', 'familia'].includes(c));
    const needsTopics   = contexts.some(c => ['saude', 'projeto', 'familia', 'casual', 'rotina'].includes(c));
    const needsDiary    = contexts.some(c => ['diario', 'meta', 'emocao', 'casual'].includes(c));
    const needsRecs     = contexts.some(c => ['recomendacao', 'casual'].includes(c));

    // Cargas paralelas condicionais
    const [
      googleCtx,
      msCtx,
      topicBlock,
      diaryBlock,
      gapsBlock,
    ] = await Promise.all([
      needsCalendar ? getGoogleContext().catch(() => null)            : Promise.resolve(null),
      needsCalendar ? getMicrosoftCalendarContext().catch(() => null) : Promise.resolve(null),
      needsTopics   ? buildTopicBlock(userId_, message)               : Promise.resolve(''),
      needsDiary    ? buildDiaryGoalsBlock(userId_)                   : Promise.resolve(''),
      buildGapsBlock(userId_, message),
    ]);

    const recsBlock = needsRecs ? await buildRecommendationsBlock(userId_, message) : '';

    // RAM
    const { data: history } = await supabase
      .from('brain').select('content, metadata')
      .eq('user_id', userId_).eq('session_id', sessionId)
      .neq('category', 'archived')
      .order('created_at', { ascending: false }).limit(8);

    const ramBlock = history && history.length >= 2
      ? [...history].reverse().map((h: any) => {
          const ai = (h.metadata?.ai_reply || '').replace(/\[.*?\]/g, '').trim();
          return `${authorName}: ${h.content}\n${assistantName}: ${ai}`;
        }).join('\n\n')
      : '';

    // HD vetorial
    const embedding = await generateEmbedding(message);
    let hdBlock = '';
    let hdIds: string[] = [];
    if (embedding) {
      const { data: search } = await supabase.rpc('match_memories', {
        query_embedding: embedding, match_threshold: 0.4, match_count: 3,
      }) as { data: any[] | null };
      if (search?.length) {
        hdBlock = search.filter(r => !r.summary.startsWith('[CINZA]')).map(r => r.summary).join('\n---\n');
        hdIds   = search.map(r => r.id);
      }
    }

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

    // ── Streaming response ───────────────────────────────────────────────────
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
            // Envia chunk como SSE
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
          }
        } catch (e: any) {
          if (e.name !== 'AbortError') {
            console.error('[chat/stream] Erro:', e.message);
          }
        } finally {
          clearTimeout(timeoutId);

          // Remove gatilhos e extrai classe antes de enviar [DONE]
          const categoryMatch = fullReply.match(/\[CLASSE:\s*(\w+)\]/i);
          const category      = categoryMatch?.[1]?.toLowerCase() || 'info';
          let cleanReply      = fullReply.replace(/\[CLASSE:\s*\w+\]/gi, '').trim();

          // Processa gatilhos de evento
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

          // Sinaliza fim com resposta final limpa
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
    console.error('[chat] Erro:', error.message);
    return new Response(JSON.stringify({ error: 'Erro interno' }), { status: 500 });
  }
} 