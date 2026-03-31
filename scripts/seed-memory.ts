// scripts/seed-memory.ts
// Executa com: npx ts-node scripts/seed-memory.ts
// Gera embedding do dossiê L3 e insere como memória HD no banco

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

const USER_ID = 8595482774;

async function generateEmbedding(text: string): Promise<number[] | null> {
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'Jarvis AI',
    },
    body: JSON.stringify({
      model: 'openai/text-embedding-3-small',
      input: text,
      dimensions: 1536,
    }),
  });

  if (!res.ok) {
    console.error('[Embedding] Erro:', res.status, await res.text());
    return null;
  }

  const json = await res.json();
  return json.data?.[0]?.embedding || null;
}

async function main() {
  console.log('Buscando dossiê L3...');

  const { data: user, error } = await supabase
    .from('users')
    .select('current_context')
    .eq('id', USER_ID)
    .single();

  if (error || !user?.current_context) {
    console.error('Erro ao buscar dossiê:', error);
    process.exit(1);
  }

  const dossie = user.current_context;
  console.log('Dossiê encontrado, primeiros 100 chars:', dossie.substring(0, 100));

  console.log('Deletando memórias antigas...');
  const { error: deleteError } = await supabase
    .from('memories')
    .delete()
    .eq('user_id', USER_ID);

  if (deleteError) {
    console.error('Erro ao deletar memórias:', deleteError);
    process.exit(1);
  }
  console.log('Memórias antigas deletadas.');

  console.log('Gerando embedding...');
  const embedding = await generateEmbedding(dossie);

  if (!embedding) {
    console.error('Falha ao gerar embedding.');
    process.exit(1);
  }
  console.log('Embedding gerado, dimensões:', embedding.length);

  console.log('Inserindo memória HD...');
  const { error: insertError } = await supabase.from('memories').insert([{
    summary: dossie,
    embedding,
    user_id: USER_ID,
    project_tag: 'pessoal',
    relevance_score: 1.0,
    access_count: 0,
    decay_lambda: 0.001,
    emotional_weight: 0.8,
    decay_type: 'permanent',
    category: 'info',
    metadata: { type: 'manual_seed', source: 'dossie_l3' },
  }]);

  if (insertError) {
    console.error('Erro ao inserir memória:', insertError);
    process.exit(1);
  }

  console.log('✅ Memória HD criada com sucesso a partir do dossiê!');
}

main().catch(console.error);