import { NextResponse } from 'next/server';
import { supabase, callOpenRouter, generateEmbedding } from '@/lib/jarvis';

// ============================================================
// /api/admin/consolidate
// 
// PROPÓSITO: Pegar as memórias criadas pelo SQL (Passo 3)
// que ainda não têm embedding, e vetorizá-las em lotes.
//
// Também reconstrói o Dossiê L3 do usuário a partir de
// todo o histórico consolidado.
//
// Como usar:
//   GET /api/admin/consolidate?auth=SEU_CRON_SECRET&mode=embeddings
//   GET /api/admin/consolidate?auth=SEU_CRON_SECRET&mode=dossie&userId=SEU_TELEGRAM_ID
//   GET /api/admin/consolidate?auth=SEU_CRON_SECRET&mode=all&userId=SEU_TELEGRAM_ID
// ============================================================

export const maxDuration = 60;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const auth = searchParams.get('auth');
  const mode = searchParams.get('mode') || 'embeddings';
  const userId = searchParams.get('userId');
  const batchSize = parseInt(searchParams.get('batch') || '5');

  // Segurança
  if (auth !== process.env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const results: any = { mode, processed: 0, errors: 0, details: [] };

  try {

    // ============================================================
    // MODO: embeddings
    // Vetoriza as memórias que vieram do backfill SQL
    // ============================================================
    if (mode === 'embeddings' || mode === 'all') {

      // Busca memórias sem embedding (criadas pelo SQL)
      const { data: pending } = await supabase
        .from('memories')
        .select('id, summary, user_id, metadata')
        .is('embedding', null)
        .limit(batchSize);  // Processa em lotes para não estourar o timeout

      if (pending && pending.length > 0) {
        for (const memory of pending) {
          try {
            // Gera embedding do summary
            const embedding = await generateEmbedding(memory.summary);

            if (embedding) {
              await supabase
                .from('memories')
                .update({
                  embedding,
                  metadata: {
                    ...memory.metadata,
                    needs_embedding: false,
                    embedded_at: new Date().toISOString()
                  }
                })
                .eq('id', memory.id);

              results.processed++;
              results.details.push({ id: memory.id, status: 'embedded', chars: memory.summary.length });
            } else {
              results.errors++;
              results.details.push({ id: memory.id, status: 'embedding_failed' });
            }

          } catch (e: any) {
            results.errors++;
            results.details.push({ id: memory.id, status: 'error', message: e.message });
          }

          // Pausa de 200ms entre embeddings para não bater rate limit
          await new Promise(r => setTimeout(r, 200));
        }

        // Quantas ainda faltam?
        const { count: remaining } = await supabase
          .from('memories')
          .select('*', { count: 'exact', head: true })
          .is('embedding', null);

        results.remaining = remaining || 0;
        results.message = remaining
          ? `Lote processado. Ainda faltam ${remaining} memórias. Chame novamente para continuar.`
          : `✅ Todas as memórias foram vetorizadas!`;
      } else {
        results.message = '✅ Nenhuma memória pendente de embedding.';
      }
    }

    // ============================================================
    // MODO: dossie
    // Reconstrói o Dossiê L3 do usuário a partir de TUDO
    // ============================================================
    if ((mode === 'dossie' || mode === 'all') && userId) {

      // Busca todas as memórias do usuário já vetorizadas, da mais antiga para a mais recente
      const { data: allMemories } = await supabase
        .from('memories')
        .select('summary, metadata, updated_at')
        .eq('user_id', userId)
        .not('embedding', 'is', null)
        .order('updated_at', { ascending: true });

      if (!allMemories || allMemories.length === 0) {
        results.dossie = 'Nenhuma memória vetorizada encontrada para este usuário.';
      } else {

        // Monta o texto histórico completo para o prompt
        const historico = allMemories
          .map(m => `[${m.metadata?.date || m.updated_at?.substring(0, 10)}]\n${m.summary}`)
          .join('\n\n---\n\n');

        const prompt = `
Você é o Arquivista do Jarvis. Sua missão é criar o DOSSIÊ COMPLETO e atualizado do usuário.

Analise TODO o histórico de interações abaixo e construa um dossiê estruturado que o Jarvis 
pode usar como contexto rápido em qualquer conversa futura.

[HISTÓRICO COMPLETO DE INTERAÇÕES]
${historico.substring(0, 12000)} ${historico.length > 12000 ? '\n\n[... histórico truncado para caber no contexto ...]' : ''}

ESTRUTURA DO DOSSIÊ (retorne exatamente neste formato):

## PERFIL PESSOAL
- Nome, apelidos, localização, família
- Profissão atual e histórico recente de trabalho

## ROTINA E HÁBITOS
- Horários, academia, hábitos confirmados
- Preferências de comunicação com o Jarvis

## PROJETOS E OBJETIVOS
- Projetos ativos e seus status
- Metas de curto e longo prazo

## EVENTOS E DATAS IMPORTANTES
- Aniversários, compromissos recorrentes
- Próximos eventos relevantes

## PREFERÊNCIAS E PERSONALIZAÇÃO
- Como o usuário gosta que o Jarvis se comporte
- Ajustes de humor, tom, formato solicitados
- Coisas que irritam ou agradam

## CONTEXTO RECENTE
- Últimas decisões importantes tomadas
- Assuntos em aberto ou pendentes

Seja denso e preciso. Preserve datas e nomes específicos. Não invente nada que não esteja no histórico.
        `;

        const dossie = await callOpenRouter(prompt);

        // Salva no L3 (current_context do usuário)
        await supabase
          .from('users')
          .update({ current_context: dossie })
          .eq('id', userId);

        results.dossie = 'Dossiê reconstruído com sucesso!';
        results.dossie_chars = dossie.length;
        results.memories_used = allMemories.length;
      }
    }

    return NextResponse.json(results);

  } catch (error: any) {
    console.error("Erro na consolidação:", error.message);
    return NextResponse.json({ error: error.message, partial: results }, { status: 500 });
  }
}
