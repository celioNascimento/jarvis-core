// ============================================================
// lib/extractor.ts — Orquestrador Modular (Registry Pattern)
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { 
  extractProjeto, extractEvento, extractAgenda, 
  extractRotina, extractPreferencia, extractRecomendacao, 
  extractFamilia, extractShopping
} from '@/lib/extractor-jobs';
import { callAI } from './Utils/ai-helpers';
import { updateL3 } from './services/memory.service';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

// ── Tipos ────────────────────────────────────────────────────
export interface DetectedGap {
  field: string;
  context: string;
  hint: string;
  urgencia?: string;
}

// ── REGISTRO DE MÓDULOS ──────────────────────────────────────
const EXTRACTION_MODULES = [
  { 
    id: 'familia', 
    match: (ctx: string[], msg: string) => ctx.includes('familia'), 
    run: (uid: string, msg: string, reply: string, gaps: DetectedGap[]) => extractFamilia(uid, msg, gaps) 
  },
  { id: 'projeto', match: (ctx: string[], msg: string) => ctx.includes('projeto'), run: (uid: string, msg: string) => extractProjeto(uid, msg) },
  { id: 'evento',  match: (ctx: string[], msg: string) => ctx.includes('evento'),  run: (uid: string, msg: string) => extractEvento(uid, msg) },
  { id: 'agenda',  match: (ctx: string[], msg: string) => ctx.includes('agenda'),  run: (uid: string, msg: string) => extractAgenda(uid, msg) },
  { id: 'rotina',  match: (ctx: string[], msg: string) => ctx.includes('rotina'),  run: (uid: string, msg: string) => extractRotina(uid, msg) },
  { id: 'preferencia', match: (ctx: string[], msg: string) => ctx.includes('preferencia'), run: (uid: string, msg: string) => extractPreferencia(uid, msg) },
  { id: 'recomendacao', match: (ctx: string[], msg: string) => ctx.includes('recomendacao'), run: (uid: string, msg: string, reply: string) => extractRecomendacao(uid, msg, reply) },
  { id: 'compras', match: (ctx: string[], msg: string) => ctx.includes('compras'), run: (uid: string, msg: string, reply: string) => extractShopping(uid, msg, reply) },
];

// ── ORQUESTRADOR PRINCIPAL ───────────────────────────────────

export async function extractAndSummarize(
  maybeUuid: string,
  userName: string,
  userMessage: string,
  aiReply: string = ''
): Promise<string> {
  // 1. Resolve ID Numérico
  let userId = maybeUuid;
  if (maybeUuid.includes('-')) {
    const { data } = await supabase.from('users').select('id').eq('auth_user_id', maybeUuid).maybeSingle();
    if (!data) return '';
    userId = String(data.id);
  }

  try {
    // 2. Classificação
    const classification = await classify(userMessage);
    if (!classification.has_new_facts) return '';

    // 3. Execução dos Módulos (Fire & Forget)
    const tasks: Promise<void>[] = [];
    for (const mod of EXTRACTION_MODULES) {
      if (mod.match(classification.contexts, userMessage)) {
        // Passamos '[]' para gaps caso não queira integrar com a lógica legada agora
        tasks.push(mod.run(userId, userMessage, aiReply, [])); 
      }
    }

    Promise.allSettled(tasks).then(() => updateL3(userId).catch(console.error));
    
    return summarizeContexts(classification.contexts);
  } catch (e) {
    console.error('[Extrator/Orquestrador] Erro:', e);
    return '';
  }
}

// ── CLASSIFICADOR ────────────────────────────────────────────

async function classify(userMessage: string) {
  const prompt = `Analise a mensagem e retorne JSON: {"has_new_facts": boolean, "contexts": string[]}. Contextos: familia, projeto, evento, agenda, rotina, preferencia, recomendacao, compras. Mensagem: "${userMessage}"`;
  try {
    const raw = await callAI(prompt, 200);
    return JSON.parse(raw.replace(/```json|```/g, ''));
  } catch {
    return { has_new_facts: false, contexts: [] };
  }
}

function summarizeContexts(contexts: string[]): string {
  return contexts.length > 0 ? `Atualizado: ${contexts.join(', ')}` : '';
}