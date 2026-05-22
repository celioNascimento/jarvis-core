// lib/extractor.ts — V13.2 (Contrato: Tipagem Estrita e Gateway)
import { supabase } from '@/lib/jarvis';
import { llmGateway } from '@/lib/chat/llm-gateway';
import { 
  extractProjeto, extractEvento, extractAgenda, 
  extractRotina, extractPreferencia, extractRecomendacao, 
  extractFamilia, extractShopping
} from '@/lib/extractor-jobs';
import { updateL3 } from './services/memory.service';

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

// ── REGISTRO DE MÓDULOS ──────────────────────────────────────
const EXTRACTION_MODULES = [
  { id: 'familia', match: (ctx: string[]) => ctx.includes('familia'), run: (uid: string, msg: string, gaps: DetectedGap[]) => extractFamilia(uid, msg, gaps) },
  { id: 'projeto', match: (ctx: string[]) => ctx.includes('projeto'), run: (uid: string, msg: string) => extractProjeto(uid, msg) },
  { id: 'evento',  match: (ctx: string[]) => ctx.includes('evento'),  run: (uid: string, msg: string) => extractEvento(uid, msg) },
  { id: 'agenda',  match: (ctx: string[]) => ctx.includes('agenda'),  run: (uid: string, msg: string) => extractAgenda(uid, msg) },
  { id: 'rotina',  match: (ctx: string[]) => ctx.includes('rotina'),  run: (uid: string, msg: string) => extractRotina(uid, msg) },
  { id: 'preferencia', match: (ctx: string[]) => ctx.includes('preferencia'), run: (uid: string, msg: string) => extractPreferencia(uid, msg) },
  { id: 'recomendacao', match: (ctx: string[]) => ctx.includes('recomendacao'), run: (uid: string, msg: string, reply: string) => extractRecomendacao(uid, msg, reply) },
  { id: 'compras', match: (ctx: string[]) => ctx.includes('compras'), run: (uid: string, msg: string, reply: string) => extractShopping(uid, msg, reply) },
];

// ── ORQUESTRADOR PRINCIPAL (Tipagem Estrita) ───────────────────

export async function extractAndSummarize(
  userId: string,
  userName: string,
  userMessage: string,
  aiReply: string
): Promise<string> {
  try {
    // 1. Classificação via Gateway (Regra 4)
    const classification = await classify(userId, userMessage);
    if (!classification?.has_new_facts) return '';

    // 2. Execução dos Módulos
    const tasks: Promise<void>[] = [];
    for (const mod of EXTRACTION_MODULES) {
      if (mod.match(classification.contexts)) {
        // Ajuste conforme a assinatura de cada job
        if (mod.id === 'familia') {
          tasks.push(mod.run(userId, userMessage, [])); 
        } else if (mod.id === 'recomendacao' || mod.id === 'compras') {
          tasks.push((mod as any).run(userId, userMessage, aiReply));
        } else {
          tasks.push((mod as any).run(userId, userMessage));
        }
      }
    }

    // Fire & Forget com tratamento de erro
    Promise.allSettled(tasks).then(() => updateL3(userId).catch(console.error));
    
    return summarizeContexts(classification.contexts);
  } catch (e) {
    console.error('[Extrator/Orquestrador] Erro:', e);
    return '';
  }
}

// ── CLASSIFICADOR (Gateway Integration) ─────────────────────────

async function classify(userId: string, userMessage: string) {
  const prompt = `Analise a mensagem e retorne JSON: {"has_new_facts": boolean, "contexts": string[]}. 
Contextos: familia, projeto, evento, agenda, rotina, preferencia, recomendacao, compras. 
Mensagem: "${userMessage}"`;
  
  try {
    const raw = await llmGateway.enqueue({
        id: `classify-${userId}-${Date.now()}`,
        priority: 4,
        params: {
            messages: [{ role: 'user', content: prompt }],
            model: 'google/gemini-2.0-flash-001',
            temperature: 0.1,
            timeoutMs: 10000
        },
        dedupPayload: userMessage
    });
    
    return JSON.parse(raw.content?.replace(/```json|```/g, '') || '{}');
  } catch {
    return { has_new_facts: false, contexts: [] };
  }
}

function summarizeContexts(contexts: string[]): string {
  return contexts.length > 0 ? `Atualizado: ${contexts.join(', ')}` : '';
}
