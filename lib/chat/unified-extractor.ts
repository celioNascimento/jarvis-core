// lib/chat/unified-extractor.ts
// V2.0.0 — Recomendações e fatos relevantes agora também salvos como memória HD

import { supabase, generateEmbedding } from '@/lib/jarvis';
import { extractDiary, extractGoal } from '@/lib/diary';
import { extractAndSummarize } from '@/lib/extractor';
import {  extractRecomendacao } from '@/lib/extractor-jobs';
import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway';
import { upsertEvent } from '../Utils/db-helpers';

interface UnifiedExtractResult {
  diary: { texto: string; categoria: 'reflexao' | 'acontecimento' | 'gratidao' | 'qualquer' } | null;
  goal: { titulo: string; descricao: string } | null;
  recommendation: { tipo: string; titulo: string; descricao: string } | null;
  summary: { fato: string; relevancia: 'alta' | 'media' | 'baixa' } | null;
  event: { titulo: string; data_aproximada: string; categoria: string; notas: string } | null;
}

const EMPTY: UnifiedExtractResult = {
  diary: null, goal: null, recommendation: null, summary: null, event: null,
};

function mapDiaryCategory(cat: string): 'morning' | 'evening' | 'anytime' | undefined {
  switch (cat) {
    case 'reflexao':
    case 'acontecimento':
    case 'gratidao':
      return 'anytime';
    case 'qualquer':
      return undefined;
    default:
      return 'anytime';
  }
}

function hasExtractionPotential(message: string): boolean {
  if (message.trim().length < 25) return false;
  const noise = /^(ok|sim|não|certo|tá|ta|ótimo|obrigad|valeu|vlw|show|👍|😊|olá|oi|e aí|fala)[!?,. ]*$/i;
  if (noise.test(message.trim())) return false;
  return true;
}

function parseEventDate(dataAproximada: string): string {
  const direct = new Date(dataAproximada);
  if (!isNaN(direct.getTime())) return direct.toISOString();

  const meses: Record<string, number> = {
    janeiro: 0, fevereiro: 1, março: 2, abril: 3, maio: 4, junho: 5,
    julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11,
  };
  const lower = dataAproximada.toLowerCase();
  const anoMatch = lower.match(/\b(202\d)\b/);
  const ano = anoMatch ? parseInt(anoMatch[1]) : new Date().getFullYear();

  for (const [nome, idx] of Object.entries(meses)) {
    if (lower.includes(nome)) {
      const semana = lower.includes('primeira') ? 1
        : lower.includes('segunda') ? 8
          : lower.includes('terceira') ? 15
            : lower.includes('última') || lower.includes('ultima') ? 22
              : 1;
      return new Date(ano, idx, semana).toISOString();
    }
  }

  const fallback = new Date();
  fallback.setMonth(fallback.getMonth() + 3);
  return fallback.toISOString();
}

async function extractAllFields(
  message: string,
  reply: string,
): Promise<UnifiedExtractResult> {
  const prompt = `Analise o diálogo abaixo e extraia informações estruturadas.
Retorne APENAS JSON válido, sem markdown, sem comentários.

USUÁRIO: ${message.slice(0, 400)}
ASSISTENTE: ${reply.slice(0, 400)}

Campos esperados:
{
  "diary": null | { "texto": "<frase curta sobre sentimento ou acontecimento>", "categoria": "reflexao"|"acontecimento"|"gratidao"|"qualquer" },
  "goal": null | { "titulo": "<título curto>", "descricao": "<descrição>" },
  "recommendation": null | { "tipo": "livro"|"filme"|"série"|"podcast"|"lugar"|"produto"|"presente"|"outro", "titulo": "<título>", "descricao": "<por que foi recomendado>" },
  "summary": null | { "fato": "<fato novo aprendido sobre o usuário, max 80 chars>", "relevancia": "alta"|"media"|"baixa" },
  "event": null | { "titulo": "<nome do evento>", "data_aproximada": "<ISO 2026-05-04 ou texto 'primeira semana de maio 2026'>", "categoria": "<Viagem|Trabalho|Pessoal|Saúde|Família|Escola|Lazer>", "notas": "<contexto relevante>" }
}

Regras:
- Se não houver dado relevante para um campo, deixe null.
- Não invente. Extraia apenas o que está explícito ou fortemente implícito.
- "diary" só quando o usuário expressar sentimento, reflexão ou acontecimento pessoal.
- "goal" só quando houver meta, objetivo ou plano concreto.
- "recommendation" quando o assistente sugerir OU o usuário mencionar qualquer produto, presente, lugar, filme, livro, série, podcast.
- "summary" para qualquer fato novo sobre o usuário (profissão, cidade, preferência, hábito).
- "event" quando o usuário mencionar qualquer situação futura com data ou período.`;

  try {
    // Passa pelo Gatekeeper (Fila de Prioridade 3 - Extratores)
    const response = await callOpenRouterWithPriority(
      3, 
      'if_full', 
      `extract_unified_${Date.now()}`, 
      [{ role: 'user', content: prompt }],
      [],
      'google/gemini-2.0-flash-001',
      0.1,
      35000,
      1500,
      'none'
    );

    // Garante que pega o texto corretamente, independentemente do formato de retorno
    const content = (response as any)?.content || (typeof response === 'string' ? response : '');
    
    const clean = content.replace(/```json|```/g, '').trim();
    return JSON.parse(clean) as UnifiedExtractResult;
    
  } catch (e) {
    console.warn('[UnifiedExtractor] Parse/Execução falhou, retornando vazio:', (e as Error).message);
    return EMPTY;
  }
}

// ─── saveToHD ─────────────────────────────────────────────────────────────────
//
// Salva um fato relevante diretamente na camada HD (tabela memories com embedding).
// Garante que informações importantes sejam recuperáveis via busca semântica,
// mesmo que o histórico de sessão já tenha expirado.
//
// Sem isso, recomendações e fatos de ontem ficam apenas em `recommendations`
// ou `brain`, que não são consultados pela busca vetorial do route.ts.

async function saveToHD(
  userId: string,
  summary: string,
  emotionalWeight = 0.5,
  category = 'info',
): Promise<void> {
  try {
    const embedding = await generateEmbedding(summary);
    if (!embedding) {
      console.warn('[UnifiedExtractor] HD: embedding falhou, fato não indexado:', summary.slice(0, 60));
      return;
    }

    await supabase.from('memories').insert([{
      summary,
      embedding,
      user_id: userId,
      relevance_score: 0.8,
      access_count: 0,
      decay_lambda: 0.003,
      emotional_weight: emotionalWeight,
      category,
      metadata: { type: 'unified_extractor', source: 'conversation' },
    }]);

    console.log('[UnifiedExtractor] HD salvo:', summary.slice(0, 80));
  } catch (e) {
    console.error('[UnifiedExtractor] Erro ao salvar HD:', e);
  }
}

export async function runUnifiedExtractor(
  userId: string,
  authorName: string,
  message: string,
  reply: string,
): Promise<void> {
  if (!hasExtractionPotential(message)) {
    console.log('[UnifiedExtractor] Mensagem sem substância — pulando.');
    return;
  }

  const data = await extractAllFields(message, reply);
  const tasks: Promise<any>[] = [];

  // ── Diário ────────────────────────────────────────────────────────────────
  if (data.diary) {
    const mappedCategory = mapDiaryCategory(data.diary.categoria);
    tasks.push(
      extractDiary(userId, data.diary.texto, mappedCategory)
        .catch(e => console.error('[UnifiedExtractor] diary:', e)),
    );
  }

  // ── Meta / Objetivo ───────────────────────────────────────────────────────
  if (data.goal) {
    tasks.push(
      extractGoal(userId, message)
        .catch(e => console.error('[UnifiedExtractor] goal:', e)),
    );
  }

  // ── Recomendação ──────────────────────────────────────────────────────────
  // Salva em duas camadas:
  //   1. tabela `recommendations` — para o buildRecommendationsBlock
  //   2. memória HD — para recuperação semântica em conversas futuras
  if (data.recommendation) {
    const hdSummary = `Lev indicou para ${authorName}: ${data.recommendation.titulo} (${data.recommendation.tipo}) — ${data.recommendation.descricao}`;

    tasks.push(
      extractRecomendacao(userId, message, reply)
        .catch(e => console.error('[UnifiedExtractor] recommendation:', e)),
    );

    tasks.push(
      saveToHD(userId, hdSummary, 0.6, 'recommendation')
        .catch(e => console.error('[UnifiedExtractor] recommendation HD:', e)),
    );
  }

  // ── Fato sobre o usuário ──────────────────────────────────────────────────
  // Alta relevância → salva no HD para recuperação futura
  if (data.summary) {
    tasks.push(
      extractAndSummarize(userId, authorName, message)
        .catch(e => console.error('[UnifiedExtractor] summary:', e)),
    );

    if (data.summary.relevancia === 'alta') {
      tasks.push(
        saveToHD(userId, data.summary.fato, 0.7, 'fact')
          .catch(e => console.error('[UnifiedExtractor] summary HD:', e)),
      );
    }
  }

  // ── Evento ────────────────────────────────────────────────────────────────
  if (data.event) {
    tasks.push(
      (async () => {
        try {
          const eventDate = parseEventDate(data.event!.data_aproximada);
          await upsertEvent(userId, {
            title: data.event!.titulo,
            event_date: eventDate,
            category: data.event!.categoria,
            priority: 'media',
            decay_type: 'one_time',
            emotional_weight: 0.6,
            is_recurring: false,
            notes: data.event!.notas || null,
          });
          console.log(`[UnifiedExtractor] Evento salvo: "${data.event!.titulo}" → ${eventDate}`);
        } catch (e) {
          console.error('[UnifiedExtractor] event:', e);
        }
      })()
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
    console.log(`[UnifiedExtractor] Extraído: diary=${!!data.diary} goal=${!!data.goal} rec=${!!data.recommendation} summary=${!!data.summary} event=${!!data.event}`);
  } else {
    console.log('[UnifiedExtractor] Nenhum dado extraível nesta mensagem.');
  }
}
