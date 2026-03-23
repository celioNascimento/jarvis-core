// app/api/chat/route.ts
// Canal web/app para o motor Lev
// Resposta JSON única (sem SSE) — compatível com React Native

import {
  supabase,
  generateEmbedding,
  reinforceMemory,
  getOrCreateSession,
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

export const maxDuration = 10;

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type ContextType =
  | 'agenda' | 'projeto' | 'familia' | 'emocao' | 'diario' | 'meta'
  | 'saude' | 'recomendacao' | 'evento' | 'rotina' | 'preferencia'
  | 'alias' | 'email' | 'casual';

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

async function callOpenRouterSync(
  messages: ChatMessage[],
  model: string,
  temperature: number
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, max_tokens: 800, temperature, stream: false, messages }),
    });

    clearTimeout(timeout);
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (e: any) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('Timeout OpenRouter');
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    console.log('[chat] 1. parse body');
    const { message, userId, sessionId: clientSessionId, userEmail } = await req.json();
    console.log('[chat] 2. message:', message?.slice(0, 30), '| email:', userEmail, '| userId:', userId);

    if (!message) {
      return Response.json({ error: 'message obrigatório' }, { status: 400 });
    }

    // Resolve email — fallback para admin lookup se app não enviou
    let resolvedEmail = userEmail;
    if (!resolvedEmail && userId) {
      console.log('[chat] admin lookup pelo userId');
      const { data: authData } = await supabase.auth.admin.getUserById(userId);
      resolvedEmail = authData?.user?.email || '';
      console.log('[chat] email via admin lookup:', resolvedEmail);
    }

    if (!resolvedEmail) {
      return Response.json({ error: 'Não foi possível identificar o usuário' }, { status: 400 });
    }

    // Busca usuário por email
    console.log('[chat] 3. buscando usuário:', resolvedEmail);
    const { data: userProfile, error: userError } = await supabase
      .from('users')
      .select('id, nickname, current_context, assistant_name, timezone')
      .eq('email', resolvedEmail)
      .maybeSingle();

    console.log('[chat] 4. userProfile:', userProfile?.id, '| erro:', userError?.message);

    if (userError) return Response.json({ error: 'Erro ao buscar usuário' }, { status: 500 });
    if (!userProfile) return Response.json({ error: 'Usuário não encontrado' }, { status: 404 });

    const userId_       = String(userProfile.id);
    const authorName    = userProfile.nickname       || 'você';
    const assistantName = userProfile.assistant_name || 'Lev';
    const userTimezone  = userProfile.timezone       || 'America/Sao_Paulo';

    // Sessão
    const sessionId = clientSessionId || (await getOrCreateSession(userId_));
    console.log('[chat] 5. sessionId:', sessionId);

    // Classificação
    const contexts    = classifyContext(message);
    const model       = routeModel(contexts);
    const temperature = getTemperature(contexts);
    console.log('[chat] 6. contexts:', contexts, '| model:', model);

    const needsCalendar = contexts.some(c => ['agenda', 'evento', 'familia'].includes(c));
    const needsTopics   = contexts.some(c => ['saude', 'projeto', 'familia', 'casual', 'rotina'].includes(c));
    const needsDiary    = contexts.some(c => ['diario', 'meta', 'emocao', 'casual'].includes(c));
    const needsRecs     = contexts.some(c => ['recomendacao', 'casual'].includes(c));

    // Cargas paralelas
    const [googleCtx, msCtx, topicBlock, diaryBlock, gapsBlock] = await Promise.all([
      needsCalendar ? getGoogleContext().catch(() => null)              : Promise.resolve(null),
      needsCalendar ? getMicrosoftCalendarContext().catch(() => null)   : Promise.resolve(null),
      needsTopics   ? buildTopicBlock(userId_, message).catch(() => '') : Promise.resolve(''),
      needsDiary    ? buildDiaryGoalsBlock(userId_).catch(() => '')     : Promise.resolve(''),
      buildGapsBlock(userId_, message).catch(() => ''),
    ]);

    const recsBlock = needsRecs
      ? await buildRecommendationsBlock(userId_, message).catch(() => '')
      : '';

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

    const fusoHorario = new Date().toLocaleString('pt-BR', { timeZone: userTimezone });

    const systemPrompt = `
Você é ${assistantName}, assistente pessoal de ${authorName}.
Data/hora: ${fusoHorario}

${googleCtx  ? `[AGENDA GOOGLE]\n${googleCtx}`                                                      : ''}
${msCtx      ? `[AGENDA OUTLOOK]\n${msCtx}`                                                         : ''}
${userProfile.current_context ? `[QUEM É ${authorName.toUpperCase()}]\n${userProfile.current_context}` : ''}
${recsBlock  ? recsBlock                                                                             : ''}
${topicBlock ? topicBlock                                                                             : ''}
${diaryBlock ? diaryBlock                                                                             : ''}
${hdBlock    ? `[MEMÓRIAS]\n${hdBlock}`                                                              : ''}
${ramBlock   ? `[CONVERSA RECENTE]\n${ramBlock}`                                                     : ''}
${gapsBlock  ? gapsBlock                                                                             : ''}

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

    console.log('[chat] 7. chamando OpenRouter');
    const fullReply = await callOpenRouterSync(conversationMessages, model, temperature);
    console.log('[chat] 8. resposta length:', fullReply.length);

    // Processa gatilhos e limpa resposta
    const categoryMatch = fullReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category      = categoryMatch?.[1]?.toLowerCase() || 'info';
    let cleanReply      = fullReply.replace(/\[CLASSE:\s*\w+\]/gi, '').trim();

    const eventRegex = /\[SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\s*\|\s*(recurring_annual|deadline|one_time)\]/gi;
    for (const m of Array.from(cleanReply.matchAll(eventRegex)) as any[]) {
      await upsertEvent(userId_, {
        title: m[1].trim(), event_date: m[2], priority: m[3],
        is_recurring: m[4] === 'true', decay_type: m[5],
        category: 'personal', emotional_weight: m[3] === 'alta' ? 0.9 : 0.5,
      }).catch(() => {});
      cleanReply = cleanReply.replace(m[0], '').trim();
    }

    const goalMatch = cleanReply.match(/\[ATUALIZAR_META:\s*([^|]+)\|\s*(\d+)(?:\|\s*([^\]]+))?\]/i);
    if (goalMatch) {
      await updateGoalProgress(userId_, goalMatch[1].trim(), parseInt(goalMatch[2]), goalMatch[3]?.trim()).catch(() => {});
      cleanReply = cleanReply.replace(goalMatch[0], '').trim();
    }

    console.log('[chat] 9. enviando resposta');

    // Background: persiste + extratores (não bloqueia a resposta)
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

    return Response.json({ reply: cleanReply, sessionId });

  } catch (error: any) {
    console.error('[chat] ERRO:', error.message);
    console.error('[chat] STACK:', error.stack?.slice(0, 500));
    return Response.json({ error: 'Erro interno' }, { status: 500 });
  }
}