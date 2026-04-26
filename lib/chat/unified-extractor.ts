// lib/chat/unified-extractor.ts
// Substitui as 4 chamadas individuais (extractAndSummarize, extractRecomendacao,
// extractDiary, extractGoal) por uma única chamada ao Gemini Flash.
// Reduz de 4 calls/request → 1 call/request em background.

import { callOpenRouter } from '@/lib/jarvis';
import { extractDiary, extractGoal } from '@/lib/diary';
import { extractAndSummarize } from '@/lib/extractor';
import { extractRecomendacao } from '@/lib/extractor-jobs';
import { supabase } from '@/lib/jarvis';

interface UnifiedExtractResult {
  diary:          { texto: string; categoria: 'reflexao' | 'acontecimento' | 'gratidao' | 'qualquer' } | null;
  goal:           { titulo: string; descricao: string } | null;
  recommendation: { tipo: string; titulo: string; descricao: string } | null;
  summary:        { fato: string; relevancia: 'alta' | 'media' | 'baixa' } | null;
  event:          { titulo: string; data_aproximada: string; categoria: string; notas: string } | null;
}

const EMPTY: UnifiedExtractResult = {
  diary: null, goal: null, recommendation: null, summary: null, event: null,
};

/**
 * Mapeia a categoria do LLM para o tipo esperado pela função extractDiary.
 */
function mapDiaryCategory(cat: string): 'morning' | 'evening' | 'anytime' | undefined {
  switch (cat) {
    case 'reflexao':
    case 'acontecimento':
    case 'gratidao':
      return 'anytime';  // sem horário específico
    case 'qualquer':
      return undefined;   // genérico, não usar categoria
    default:
      return 'anytime';
  }
}

/**
 * Detecta se a mensagem tem substância suficiente para valer uma extração.
 * Evita chamar a API em saudações, respostas curtas e ruído.
 */
function hasExtractionPotential(message: string): boolean {
  if (message.trim().length < 25) return false;

  const noise = /^(ok|sim|não|certo|tá|ta|ótimo|obrigad|valeu|vlw|show|👍|😊|olá|oi|e aí|fala)[!?,. ]*$/i;
  if (noise.test(message.trim())) return false;

  return true;
}

/**
 * Executa uma única chamada ao LLM para extrair diário, meta, recomendação e
 * resumo de uma conversa. Cada campo é null se não houver dado relevante.
 */
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
  "goal":  null | { "titulo": "<título curto>", "descricao": "<descrição>" },
  "recommendation": null | { "tipo": "livro"|"filme"|"série"|"podcast"|"lugar"|"outro", "titulo": "<título>", "descricao": "<por que foi recomendado>" },
  "summary": null | { "fato": "<fato novo aprendido sobre o usuário, max 80 chars>", "relevancia": "alta"|"media"|"baixa" }
}

Regras:
- Se o diálogo não contiver dado relevante para um campo, deixe null.
- Não invente informações. Extraia somente o que está explícito ou fortemente implícito.
- "diary" só quando o usuário expressar sentimento, reflexão ou acontecimento pessoal.
- "goal" só quando o usuário mencionar uma meta, objetivo ou plano concreto.
- "recommendation" só quando houver menção explícita a livro, série, filme, lugar etc.
"summary": null | { "fato": "<fato novo aprendido sobre o usuário, max 80 chars>", "relevancia": "alta"|"media"|"baixa" },
  "event": null | { "titulo": "<nome do evento>", "data_aproximada": "<ex: 2026-05-04 ou 'semana do dia das mães 2026'>", "categoria": "<Viagem|Trabalho|Pessoal|Saúde|Família>", "notas": "<contexto relevante>" }
}
- "event" quando o usuário mencionar qualquer situação futura com data ou período:
  viagem, consulta médica, reunião, aniversário, formatura, show, festa,
  prazo de entrega, voo, hospedagem, compromisso de trabalho, mudança,
  período de férias, retorno de viagem, evento escolar, exame, procedimento.
  Se tiver data exata use ISO (2026-05-04). Se for aproximada use texto ("primeira semana de maio 2026").

Regras:

  try {
    const raw = await callOpenRouter(prompt, 'google/gemini-2.0-flash-001', 0.1);
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean) as UnifiedExtractResult;
  } catch (e) {
    console.warn('[UnifiedExtractor] Parse falhou, retornando vazio:', (e as Error).message);
    return EMPTY;
  }
}

/**
 * Ponto de entrada principal. Chama a API uma vez e despacha os resultados
 * para as funções de persistência individuais em paralelo.
 *
 * Substitui no route.ts:
 *   extractAndSummarize(...)
 *   extractRecomendacao(...)
 *   extractDiary(...)
 *   extractGoal(...)
 */
export async function runUnifiedExtractor(
  userId: string,
  authorName: string,
  message: string,
  reply: string,
): Promise<void> {
  // Pré-filtro: não chama API para mensagens sem substância
  if (!hasExtractionPotential(message)) {
    console.log('[UnifiedExtractor] Mensagem sem substância — pulando.');
    return;
  }

  const data = await extractAllFields(message, reply);

  // Despacha em paralelo somente os campos presentes
  const tasks: Promise<any>[] = [];

  if (data.diary) {
    const mappedCategory = mapDiaryCategory(data.diary.categoria);
    tasks.push(
      extractDiary(userId, data.diary.texto, mappedCategory)
        .catch(e => console.error('[UnifiedExtractor] diary:', e)),
    );
  }

  if (data.goal) {
    // extractGoal usa a mensagem original para manter compatibilidade com a assinatura existente
    tasks.push(
      extractGoal(userId, message)
        .catch(e => console.error('[UnifiedExtractor] goal:', e)),
    );
  }

  if (data.recommendation) {
    tasks.push(
      extractRecomendacao(userId, message, reply)
        .catch(e => console.error('[UnifiedExtractor] recommendation:', e)),
    );
  }

  if (data.summary) {
    tasks.push(
      extractAndSummarize(userId, authorName, message)
        .catch(e => console.error('[UnifiedExtractor] summary:', e)),
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
    console.log(`[UnifiedExtractor] Extraído: diary=${!!data.diary} goal=${!!data.goal} rec=${!!data.recommendation} summary=${!!data.summary}`);
  } else {
    console.log('[UnifiedExtractor] Nenhum dado extraível nesta mensagem.');
  }
}
