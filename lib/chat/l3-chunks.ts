// lib/chat/l3-chunks.ts
// V1.0.0 — L3 semântico: dossiê fatiado em chunks temáticos com embedding
//
// Fluxo de escrita: dossiê → fatiar → embedding por chunk → l3_chunks
// Fluxo de leitura: embedding da mensagem → match_l3_chunks → chunks relevantes
//
// Temas reconhecidos: perfil, familia, rotina, projetos, saude, financas,
//                     preferencias, fe, objetivos, datas

import { supabase } from '@/lib/jarvis';
import { Redis } from '@upstash/redis';
import { generateEmbedding } from '@/lib/memory';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface L3Chunk {
  theme: string;
  content: string;
  similarity?: number;
}

// ─── Mapeamento de seções do dossiê → temas ──────────────────────────────────
//
// O dossiê pode ter seções com ## (markdown) ou prefixos como "- Nome:"
// Cada padrão mapeia para um tema canônico usado na busca.

const THEME_PATTERNS: Array<{ theme: string; patterns: RegExp[] }> = [
  {
    theme: 'perfil',
    patterns: [
      /##\s*(perfil|sobre|quem|identidade)/i,
      /^-\s*(nome|idade|nascimento|cidade|estado|mora|nasceu|localização)/im,
    ],
  },
  {
    theme: 'familia',
    patterns: [
      /##\s*(famil|cônjuge|esposa|marido|filho|parente)/i,
      /^-\s*(esposa|marido|filho|filha|cônjuge|pai|mãe|irmão|parente)/im,
    ],
  },
  {
    theme: 'rotina',
    patterns: [
      /##\s*(rotina|dia a dia|horário|agenda diária)/i,
      /^-\s*(despertar|academia|trabalho|dormir|lembrete|horário)/im,
    ],
  },
  {
    theme: 'projetos',
    patterns: [
      /##\s*(projeto|app|sistema|startup|produto)/i,
      /^-\s*(pqf|lev|jarvis|procuro|wm lab|deploy|mvp)/im,
    ],
  },
  {
    theme: 'saude',
    patterns: [
      /##\s*(saúde|saude|médico|medico|tratamento|diagnóstico)/i,
      /^-\s*(tdah|médico|medico|remédio|tratamento|diagnóstico|consulta)/im,
    ],
  },
  {
    theme: 'financas',
    patterns: [
      /##\s*(financ|dinheiro|renda|salário|investimento)/i,
      /^-\s*(salário|renda|banco|investimento|cartão|despesa)/im,
    ],
  },
  {
    theme: 'preferencias',
    patterns: [
      /##\s*(preferência|preferencia|gosto|interesse|hobby)/i,
      /^-\s*(comunicação|filme|música|comida|feira|pastel|gosta|prefere)/im,
    ],
  },
  {
    theme: 'fe',
    patterns: [
      /##\s*(fé|fe|religião|crença|espiritualidade)/i,
      /^-\s*(fé|fe|religião|igreja|cristão|cristã|crença)/im,
    ],
  },
  {
    theme: 'objetivos',
    patterns: [
      /##\s*(objetivo|meta|sonho|plano|futuro)/i,
      /^-\s*(objetivo|meta|sonho|quer|deseja|planeja)/im,
    ],
  },
  {
    theme: 'datas',
    patterns: [
      /##\s*(data|aniversário|comemoração|evento importante)/i,
      /^-\s*(aniversário|casamento|natal|páscoa|data)/im,
    ],
  },
];

// ─── fatiaDossie ─────────────────────────────────────────────────────────────
//
// Recebe o dossiê como texto e retorna chunks temáticos.
// Estratégia: divide por seções ## primeiro; se não houver seções markdown,
// usa linhas como unidade e agrupa por tema detectado.

export function fatiaDossie(dossie: string): L3Chunk[] {
  if (!dossie || dossie.trim().length < 50) return [];

  const chunks: L3Chunk[] = [];

  // Estratégia 1: dossiê com seções markdown (## PERFIL, ## ROTINA, etc.)
  const sections = dossie.split(/\n(?=##\s)/);
  if (sections.length > 1) {
    for (const section of sections) {
      const trimmed = section.trim();
      if (!trimmed || trimmed.length < 30) continue;

      const theme = detectTheme(trimmed);
      chunks.push({ theme, content: trimmed });
    }
    return mergeSmallChunks(chunks);
  }

  // Estratégia 2: dossiê narrativo sem seções — agrupa por linhas temáticas
  const lines = dossie.split('\n').filter(l => l.trim().length > 10);
  const groups: Record<string, string[]> = {};

  for (const line of lines) {
    const theme = detectTheme(line);
    if (!groups[theme]) groups[theme] = [];
    groups[theme].push(line);
  }

  for (const [theme, themeLines] of Object.entries(groups)) {
    const content = themeLines.join('\n').trim();
    if (content.length > 20) {
      chunks.push({ theme, content });
    }
  }

  return chunks.length > 0 ? chunks : [{ theme: 'perfil', content: dossie.trim() }];
}

function detectTheme(text: string): string {
  for (const { theme, patterns } of THEME_PATTERNS) {
    if (patterns.some(p => p.test(text))) return theme;
  }
  return 'perfil'; // fallback
}

// Junta chunks muito pequenos com o anterior
function mergeSmallChunks(chunks: L3Chunk[], minChars = 80): L3Chunk[] {
  const result: L3Chunk[] = [];
  for (const chunk of chunks) {
    if (chunk.content.length < minChars && result.length > 0) {
      result[result.length - 1].content += '\n' + chunk.content;
    } else {
      result.push({ ...chunk });
    }
  }
  return result;
}

// ─── indexL3Chunks ────────────────────────────────────────────────────────────
//
// Fatia o dossiê, gera embeddings e salva em l3_chunks.
// Chamado após qualquer atualização do dossiê.

export async function indexL3Chunks(
  userId: number,
  dossie: string
): Promise<{ indexed: number; themes: string[] }> {
  const chunks = fatiaDossie(dossie);
  if (chunks.length === 0) return { indexed: 0, themes: [] };

  // Remove chunks antigos do usuário
  await supabase
    .from('l3_chunks')
    .delete()
    .eq('user_id', userId);

  // Gera todos os embeddings em paralelo
  const withEmbeddings = await Promise.all(
    chunks.map(async chunk => ({
      chunk,
      embedding: await generateEmbedding(chunk.content),
    }))
  );

  // Filtra os que falharam
  const valid = withEmbeddings.filter(({ embedding }) => {
    if (!embedding) return false;
    return true;
  });

  const failed = chunks.length - valid.length;
  if (failed > 0) {
    console.warn(`[L3Chunks] ${failed} embedding(s) falharam e foram ignorados`);
  }

  // Batch insert — 1 query no lugar de N
  const rows = valid.map(({ chunk, embedding }) => ({
    user_id: userId,
    theme: chunk.theme,
    content: chunk.content,
    embedding,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from('l3_chunks').insert(rows);

  if (error) {
    console.error('[L3Chunks] Erro no batch insert:', error.message);
    return { indexed: 0, themes: [] };
  }

  // Invalida cache Redis
  await redis.del(`l3_chunks_${userId}`).catch(() => { });

  const indexed = valid.map(({ chunk }) => chunk.theme);
  console.log(`[L3Chunks] Indexados: ${indexed.join(', ')}`);
  return { indexed: indexed.length, themes: indexed };
}

// ─── getRelevantL3Chunks ──────────────────────────────────────────────────────
//
// Busca os chunks de L3 mais relevantes para a mensagem atual.
// Usa embedding da mensagem para busca semântica.
// Fallback: retorna chunks de perfil e família se não houver match.

export async function getRelevantL3Chunks(
  userId: number,
  queryEmbedding: number[],
  threshold = 0.3,
  maxChunks = 3
): Promise<string> {
  try {
    // Tenta busca semântica
    const { data: results, error } = await supabase.rpc('match_l3_chunks', {
      query_embedding: queryEmbedding,
      p_user_id: userId,
      match_threshold: threshold,
      match_count: maxChunks,
    });

    if (error) {
      console.error('[L3Chunks] Erro na busca semântica:', error.message);
      return await getFallbackL3(userId);
    }

    if (!results || results.length === 0) {
      // Fallback: retorna os 2 chunks mais próximos sem threshold
      const { data: topResults } = await supabase.rpc('match_l3_chunks_top', {
        query_embedding: queryEmbedding,
        p_user_id: userId,
        match_count: 2,
      });

      if (!topResults?.length) return await getFallbackL3(userId);

      console.log(`[L3Chunks] Fallback top-2: ${topResults.map((r: any) => r.theme).join(', ')}`);
      return topResults.map((r: any) => r.content).join('\n\n');
    }

    const themes = results.map((r: any) => `${r.theme}(${r.similarity?.toFixed(2)})`).join(', ');
    console.log(`[L3Chunks] Match semântico: ${themes}`);

    return (results as L3Chunk[]).map(r => r.content).join('\n\n');

  } catch (e) {
    console.error('[L3Chunks] Exceção:', e);
    return await getFallbackL3(userId);
  }
}

// Fallback: lê current_context diretamente (comportamento legado)
async function getFallbackL3(userId: number): Promise<string> {
  try {
    const { data } = await supabase
      .from('users')
      .select('current_context')
      .eq('id', userId)
      .maybeSingle();
    return data?.current_context || '';
  } catch {
    return '';
  }
}

// ─── hasL3Chunks ─────────────────────────────────────────────────────────────
//
// Verifica se o usuário já tem chunks indexados.
// Usado para decidir se precisa indexar na primeira vez.

export async function hasL3Chunks(userId: number): Promise<boolean> {
  try {
    const { count } = await supabase
      .from('l3_chunks')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);
    return (count ?? 0) > 0;
  } catch {
    return false;
  }
}