// scripts/migrate-l3-chunks.ts
// Indexa o dossiê L3 existente em chunks semânticos
//
// Executar UMA VEZ após criar a tabela l3_chunks:
//   npx ts-node scripts/migrate-l3-chunks.ts
//
// O que faz:
//   1. Lê current_context de todos os usuários (ou de um user_id específico)
//   2. Fatia em chunks temáticos
//   3. Gera embedding para cada chunk
//   4. Salva em jarvis.l3_chunks

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

// Para rodar só para um usuário específico, defina o ID aqui.
// null = processa todos os usuários com dossiê.
const TARGET_USER_ID: number | null = 8595482774;

// ─── Helpers (inline para não depender de imports do app) ─────────────────────

function detectTheme(text: string): string {
  const t = text.toLowerCase();
  if (/##\s*(perfil|sobre|quem|identidade)|^-\s*(nome|nascimento|cidade|mora|nasceu)/m.test(t))    return 'perfil';
  if (/##\s*(famil|cônjuge|esposa|filho)|^-\s*(esposa|marido|filho|filha|cônjuge|pai|mãe)/m.test(t)) return 'familia';
  if (/##\s*(rotina|horário)|^-\s*(despertar|academia|trabalho|dormir|lembrete)/m.test(t))           return 'rotina';
  if (/##\s*(projeto|app|sistema)|^-\s*(pqf|lev|jarvis|procuro|wm lab|deploy)/m.test(t))             return 'projetos';
  if (/##\s*(saúde|médico|tratamento)|^-\s*(tdah|médico|remédio|diagnóstico)/m.test(t))              return 'saude';
  if (/##\s*(financ|dinheiro|salário)|^-\s*(salário|renda|banco|investimento)/m.test(t))             return 'financas';
  if (/##\s*(preferência|gosto|hobby)|^-\s*(comunicação|filme|comida|feira|gosta)/m.test(t))         return 'preferencias';
  if (/##\s*(fé|religião)|^-\s*(fé|igreja|cristão|crença)/m.test(t))                                 return 'fe';
  if (/##\s*(objetivo|meta|sonho)|^-\s*(objetivo|meta|quer|deseja|planeja)/m.test(t))                 return 'objetivos';
  if (/##\s*(data|aniversário)|^-\s*(aniversário|casamento|natal|páscoa)/m.test(t))                  return 'datas';
  return 'perfil';
}

function fatiaDossie(dossie: string): Array<{ theme: string; content: string }> {
  if (!dossie || dossie.trim().length < 50) return [];

  // Tenta dividir por seções markdown
  const sections = dossie.split(/\n(?=##\s)/);
  if (sections.length > 1) {
    return sections
      .map(s => s.trim())
      .filter(s => s.length > 30)
      .map(s => ({ theme: detectTheme(s), content: s }));
  }

  // Fallback: agrupa linhas por tema
  const lines = dossie.split('\n').filter(l => l.trim().length > 10);
  const groups: Record<string, string[]> = {};
  for (const line of lines) {
    const theme = detectTheme(line);
    if (!groups[theme]) groups[theme] = [];
    groups[theme].push(line);
  }

  const chunks = Object.entries(groups)
    .map(([theme, ls]) => ({ theme, content: ls.join('\n').trim() }))
    .filter(c => c.content.length > 20);

  return chunks.length > 0 ? chunks : [{ theme: 'perfil', content: dossie.trim() }];
}

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

async function indexUser(userId: number, dossie: string): Promise<void> {
  console.log(`\n→ Indexando user ${userId} (${dossie.length} chars)`);

  const chunks = fatiaDossie(dossie);
  console.log(`  Chunks detectados: ${chunks.map(c => c.theme).join(', ')}`);

  // Remove chunks antigos
  await supabase.from('l3_chunks').delete().eq('user_id', userId);

  let ok = 0;
  for (const chunk of chunks) {
    process.stdout.write(`  [${chunk.theme}] gerando embedding...`);
    const embedding = await generateEmbedding(chunk.content);
    if (!embedding) {
      console.log(' FALHOU');
      continue;
    }

    const { error } = await supabase.from('l3_chunks').insert({
      user_id:    userId,
      theme:      chunk.theme,
      content:    chunk.content,
      embedding,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.log(` ERRO: ${error.message}`);
    } else {
      console.log(' ✓');
      ok++;
    }

    // Respeita rate limit da API de embeddings
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`  ✅ ${ok}/${chunks.length} chunks indexados para user ${userId}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔄 Iniciando migração L3 → l3_chunks\n');

  let users: Array<{ id: number; current_context: string }> = [];

  if (TARGET_USER_ID) {
    const { data, error } = await supabase
      .from('users')
      .select('id, current_context')
      .eq('id', TARGET_USER_ID)
      .single();

    if (error || !data?.current_context) {
      console.error('Usuário não encontrado ou sem dossiê:', error?.message);
      process.exit(1);
    }
    users = [data];
  } else {
    const { data, error } = await supabase
      .from('users')
      .select('id, current_context')
      .not('current_context', 'is', null)
      .neq('current_context', '');

    if (error) {
      console.error('Erro ao buscar usuários:', error.message);
      process.exit(1);
    }
    users = data || [];
  }

  console.log(`Usuários para indexar: ${users.length}`);

  for (const user of users) {
    await indexUser(user.id, user.current_context);
  }

  console.log('\n✅ Migração concluída!');
}

main().catch(console.error);