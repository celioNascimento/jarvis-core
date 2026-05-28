// ============================================================
// lib/extractor.ts — V14.0 (Type-Safe Dispatcher & Pattern Matching)
// ============================================================

import { llmGateway } from '@/lib/chat/llm-gateway';
import { 
  extractProjeto, extractEvento, extractAgenda, 
  extractRotina, extractPreferencia, extractRecomendacao, 
  extractFamilia, extractShopping, extractValores
} from '@/lib/extractor-jobs';

// ── TIPOS ESTRITOS ───────────────────────────────────────────
export interface ExtractionOptions {
  userId: string;
  userName: string;
  userMessage: string;
  aiReply: string;
}

export interface ExtractionModule {
  id: string;
  match: (ctx: string[]) => boolean;
}

// ── REGISTRO DE MÓDULOS (Apenas Identificação) ───────────────
const EXTRACTION_MODULES: ExtractionModule[] = [
  { id: 'familia',      match: (ctx) => ctx.includes('familia') },
  { id: 'projeto',      match: (ctx) => ctx.includes('projeto') },
  { id: 'evento',       match: (ctx) => ctx.includes('evento') },
  { id: 'agenda',       match: (ctx) => ctx.includes('agenda') },
  { id: 'rotina',       match: (ctx) => ctx.includes('rotina') },
  { id: 'preferencia',  match: (ctx) => ctx.includes('preferencia') },
  { id: 'recomendacao', match: (ctx) => ctx.includes('recomendacao') },
  { id: 'compras',      match: (ctx) => ctx.includes('compras') },
  { id: 'valores',      match: (ctx) => ctx.includes('valores') },
];

// ── FILTROS DE RUÍDO ──────────────────────────────────────────
const NOISE_PATTERNS = [
  /^(ok|oi|olá|bom dia|boa tarde|boa noite|tudo bem|blz|vlw|obrigad)/i,
  /oxe|eita|rapaz|caramba|nossa/i,
  /você (errou|falhou|esqueceu|não lembrou)/i,
  /^(não|nao|errado|incorreto|isso não)/i,
  /correção|corrigindo|na verdade/i,
  /^.{0,20}$/, // mensagens muito curtas
];

// ── ORQUESTRADOR PRINCIPAL ────────────────────────────────────
export async function extractAndSummarize(
  userId: string,
  userName: string,
  userMessage: string,
  aiReply: string
): Promise<string> {
  try {
    // Filtra mensagens que não contêm fatos novos extraíveis
    const isNoise = NOISE_PATTERNS.some(p => p.test(userMessage.trim()));
    if (isNoise) {
      console.log('[Extractor] Mensagem filtrada como ruído — sem extração');
      return '';
    }

    const classification = await classify(userId, userMessage);
    if (!classification?.has_new_facts) return '';

    const tasks: Promise<void>[] = [];

    // Dispatcher Seguro (Pattern Matching)
    for (const mod of EXTRACTION_MODULES) {
      if (mod.match(classification.contexts)) {
        switch (mod.id) {
          case 'compras':
            tasks.push(extractShopping(userId, userMessage, aiReply));
            break;
          case 'recomendacao':
            tasks.push(extractRecomendacao(userId, userMessage, aiReply));
            break;
          case 'familia':
            tasks.push(extractFamilia(userId, userMessage));
            break;
          case 'projeto':
            tasks.push(extractProjeto(userId, userMessage));
            break;
          case 'evento':
            tasks.push(extractEvento(userId, userMessage));
            break;
          case 'agenda':
            tasks.push(extractAgenda(userId, userMessage));
            break;
          case 'rotina':
            tasks.push(extractRotina(userId, userMessage));
            break;
          case 'preferencia':
            tasks.push(extractPreferencia(userId, userMessage));
            break;
          case 'valores':
            tasks.push(extractValores(userId, userMessage));
            break;
        }
      }
    }

    Promise.allSettled(tasks).catch(console.error);

    return summarizeContexts(classification.contexts);
  } catch (e) {
    console.error('[Extrator/Orquestrador] Erro:', e);
    return '';
  }
}

// ── CLASSIFICADOR ─────────────────────────────────────────────
async function classify(userId: string, userMessage: string) {
  const prompt = `Analise a mensagem e retorne JSON: {"has_new_facts": boolean, "contexts": string[]}. 
Contextos: familia, projeto, evento, agenda, rotina, preferencia, recomendacao, compras, valores. 
Atenção: Use 'valores' para mapear crenças, filosofias de vida, fé, regras morais e traços inegociáveis.
Mensagem: "${userMessage}"`;

  try {
    const raw = await llmGateway.enqueue({
      id: `classify-${userId}-${Date.now()}`,
      priority: 4,
      params: {
        messages: [{ role: 'user', content: prompt }],
        model: 'google/gemini-2.0-flash-001',
        temperature: 0.1,
        timeoutMs: 10000,
      },
      dedupPayload: userMessage,
    });

    // Construtor RegExp previne a quebra do parser por crases
    const cleanContent = raw.content?.replace(new RegExp('\`\`\`json|\`\`\`', 'gi'), '').trim() || '{}';
    return JSON.parse(cleanContent);
  } catch {
    return { has_new_facts: false, contexts: [] };
  }
}

function summarizeContexts(contexts: string[]): string {
  return contexts.length > 0 ? `Atualizado: ${contexts.join(', ')}` : '';
}