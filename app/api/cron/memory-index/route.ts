// app/api/cron/memory-index/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { callAI } from '@/lib/extractor-jobs';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id');

    if (usersError || !users?.length) {
      console.log('[memory-index] Nenhum usuário encontrado');
      return NextResponse.json({ ok: true, processed: 0 });
    }

    let totalIndexed = 0;

    for (const user of users) {
      try {
        await indexUserMemories(String(user.id));
        totalIndexed++;
      } catch (e) {
        console.error(`[memory-index] Erro no usuário ${user.id}:`, e);
      }
    }

    console.log(`[memory-index] Concluído — ${totalIndexed} usuários processados`);
    return NextResponse.json({ ok: true, processed: totalIndexed });

  } catch (e) {
    console.error('[memory-index] Erro geral:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

async function indexUserMemories(userId: string): Promise<void> {
  const { data: lastTopic } = await supabase
    .from('topic_index')
    .select('last_indexed')
    .eq('user_id', userId)
    .order('last_indexed', { ascending: true })
    .limit(1)
    .maybeSingle();

  const since = lastTopic?.last_indexed
    ? new Date(lastTopic.last_indexed).toISOString()
    : new Date(0).toISOString();

  const { data: memories, error } = await supabase
    .from('memories')
    .select('id, summary, context_tag, module_tag, project_tag, relevance_score')
    .eq('user_id', userId)
    .gt('created_at', since)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error || !memories?.length) {
    console.log(`[memory-index] user ${userId} — sem memórias novas desde ${since}`);
    return;
  }

  console.log(`[memory-index] user ${userId} — ${memories.length} memórias para indexar`);

  const groups = new Map<string, { memoryIds: string[]; summaries: string[] }>();

  for (const mem of memories) {
    const topicKey = mem.project_tag || mem.module_tag || mem.context_tag || 'geral';
    if (!groups.has(topicKey)) groups.set(topicKey, { memoryIds: [], summaries: [] });
    const g = groups.get(topicKey)!;
    g.memoryIds.push(mem.id);
    if (mem.summary) g.summaries.push(mem.summary);
  }

  for (const [topicKey, group] of groups.entries()) {
    if (group.summaries.length === 0) continue;

    try {
      const { data: existing } = await supabase
        .from('topic_index')
        .select('id, memory_ids, entry_count, summary')
        .eq('user_id', userId)
        .eq('topic', topicKey)
        .maybeSingle();

      const { label, summary } = await generateTopicMeta(
        topicKey,
        group.summaries,
        existing?.summary ?? null
      );

      const existingIds: string[] = existing?.memory_ids || [];
      const newIds    = group.memoryIds.filter(id => !existingIds.includes(id));
      const mergedIds = [...existingIds, ...newIds];

      const payload = {
        user_id:      userId,
        topic:        topicKey,
        label,
        summary,
        memory_ids:   mergedIds,
        entry_count:  (existing?.entry_count || 0) + newIds.length,
        last_indexed: new Date().toISOString(),
        updated_at:   new Date().toISOString(),
      };

      if (existing?.id) {
        await supabase.from('topic_index').update(payload).eq('id', existing.id);
      } else {
        await supabase.from('topic_index').insert({ ...payload, created_at: new Date().toISOString() });
      }

      console.log(`[memory-index] user ${userId} — tópico "${topicKey}" → ${newIds.length} novas memórias`);
    } catch (e) {
      console.error(`[memory-index] Erro no tópico "${topicKey}":`, e);
    }
  }
}

async function generateTopicMeta(
  topicKey: string,
  newSummaries: string[],
  existingSummary: string | null
): Promise<{ label: string; summary: string }> {
  const summariesText  = newSummaries.slice(0, 20).join('\n- ');
  const contextoPrevio = existingSummary
    ? `\nContexto já indexado: "${existingSummary}"`
    : '';

  const prompt = `Você é um indexador de memória pessoal. Dado um conjunto de memórias sobre o tópico "${topicKey}", gere um label legível em português e um resumo consolidado de 1-2 frases.
${contextoPrevio}

Novas memórias:
- ${summariesText}

Retorne APENAS JSON:
{"label": "Saúde da família", "summary": "Histórico de consultas e acompanhamentos médicos dos filhos e cônjuge."}

REGRAS:
- label: nome legível do tópico, 2-4 palavras, português, sem underscores
- summary: síntese objetiva em 1-2 frases do que esse tópico cobre
- Se havia contexto prévio, o summary deve integrar o anterior com as novas informações
- Nunca mencione datas, nomes específicos ou detalhes — só o padrão geral do tópico`;

  try {
    const raw  = await callAI(prompt, 150);
    const data = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return {
      label:   data.label   || topicKey,
      summary: data.summary || '',
    };
  } catch {
    return {
      label:   topicKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      summary: existingSummary || '',
    };
  }
}