// lib/extractor.ts — V13.3 (Contrato: Tipagem Estrita e Gateway + Valores)
import { supabase } from '@/lib/jarvis';
import { llmGateway } from '@/lib/chat/llm-gateway';
import { 
  extractProjeto, extractEvento, extractAgenda, 
  extractRotina, extractPreferencia, extractRecomendacao, 
  extractFamilia, extractShopping, extractValores
} from '@/lib/extractor-jobs';

// ── Tipos Estritos ───────────────────────────────────────────
export interface ExtractionOptions {
  userId: string;
  userName: string;
  userMessage: string;
  aiReply: string;
}

export interface DetectedGap {
  field: string;
  context: string;
  hint: string;
  urgencia?: string;
}

export interface ExtractionModule {
  id: string;
  match: (ctx: string[]) => boolean;
  run: (...args: any[]) => Promise<void>;
}

// ── REGISTRO DE MÓDULOS ──────────────────────────────────────
const EXTRACTION_MODULES: ExtractionModule[] = [
  { id: 'familia',      match: (ctx) => ctx.includes('familia'),      run: (uid, msg, gaps: DetectedGap[]) => extractFamilia(uid, msg, gaps) },
  { id: 'projeto',      match: (ctx) => ctx.includes('projeto'),      run: (uid, msg) => extractProjeto(uid, msg) },
  { id: 'evento',       match: (ctx) => ctx.includes('evento'),       run: (uid, msg) => extractEvento(uid, msg) },
  { id: 'agenda',       match: (ctx) => ctx.includes('agenda'),       run: (uid, msg) => extractAgenda(uid, msg) },
  { id: 'rotina',       match: (ctx) => ctx.includes('rotina'),       run: (uid, msg) => extractRotina(uid, msg) },
  { id: 'preferencia',  match: (ctx) => ctx.includes('preferencia'),  run: (uid, msg) => extractPreferencia(uid, msg) },
  { id: 'recomendacao', match: (ctx) => ctx.includes('recomendacao'), run: (uid, msg, reply) => extractRecomendacao(uid, msg, reply) },
  { id: 'compras',      match: (ctx) => ctx.includes('compras'),      run: (uid, msg, reply) => extractShopping(uid, msg, reply) },
  { id: 'valores',      match: (ctx) => ctx.includes('valores'),      run: (uid, msg) => extractValores(uid, msg) },
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
    for (const mod of EXTRACTION_MODULES) {
      if (mod.match(classification.contexts)) {
        if (mod.id === 'familia') {
          tasks.push(mod.run(userId, userMessage, [] as DetectedGap[]));
        } else if (mod.id === 'recomendacao' || mod.id === 'compras') {
          tasks.push(mod.run(userId, userMessage, aiReply));
        } else {
          tasks.push(mod.run(userId, userMessage));
        }
      }
    }

    // updateL3 é chamado no pipeline principal via l3.extractor com masterContext completo
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

    return JSON.parse(raw.content?.replace(/```json|```/g, '') || '{}');
  } catch {
    return { has_new_facts: false, contexts: [] };
  }
}

function summarizeContexts(contexts: string[]): string {
  return contexts.length > 0 ? `Atualizado: ${contexts.join(', ')}` : '';
}
