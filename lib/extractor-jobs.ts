// ============================================================
// lib/extractor-jobs.ts — V15.1 (Refatoração de Contrato + Parser Safe)
// Responsabilidade: Apenas Prompt, Extração e Delegação para Services.
// ZERO chamadas diretas ao Supabase.
// ============================================================

import { safeParseJSON } from './Utils/ai-helpers';
import { llmGateway } from '@/lib/chat/llm-gateway';

// Importação dos Services (A Única Camada que fala com o Banco)
import { projectService } from './services/projects.service';
import { eventsService } from './services/agenda.service';
import { familyService } from '@/lib/services/family.service';
import { profileService } from '@/lib/services/profile.service';
import { shoppingService } from '@/lib/services/shopping.service';
import { recommendationsService } from './services/recommendations.service';
import { upsertPrinciple } from '@/lib/principles/principles.service';

// ── TIPAGENS ESTRITAS DE RETORNO DA IA ──────────────────────────────────
interface ExtractedProjetos { projetos?: Array<{ nome: string; tag: string; descricao?: string; status?: string; contexto_tecnico?: string }> }
interface ExtractedEventos { eventos?: Array<{ titulo: string; data: string; tipo: string; recorrente?: boolean; notas?: string }> }
interface ExtractedAgenda { compromissos?: Array<{ descricao: string; data_hora: string; categoria: string; aviso_minutos?: number }> }
interface ExtractedFamilia { esposa?: { nome: string; aniversario?: string }; marido?: { nome: string; aniversario?: string }; filhos?: Array<{ nome: string; nascimento?: string }>; pai?: any; mae?: any; }
interface ExtractedRotina { despertar?: string; dormir?: string; }
interface ExtractedPreferencia { preferencias?: Array<{ tipo: string; descricao: string }> }
interface ExtractedShopping { items?: Array<{ item: string; category?: string }> }
interface ExtractedRecomendacao { recomendacoes?: Array<{ tipo: string; nome: string; status?: string; source?: string }> }
export interface ExtractedValores { principios?: Array<{ conteudo: string; categoria: string; tipo: "declaracao" | "amadurecimento" | "desculpa"; tags?: string[] }> }

// ── HELPER CENTRAL: LLM Gateway em Background ───────────────────────────
async function runExtractorAI<T>(userId: string, prompt: string, timeoutMs: number = 15000): Promise<T | null> {
  try {
    const raw = await llmGateway.enqueue({
      id: `extract-job-${userId}-${Date.now()}`,
      priority: 4,
      params: {
        messages: [{ role: 'user', content: prompt }],
        model: 'google/gemini-2.0-flash-001',
        temperature: 0.1,
        timeoutMs
      },
      dedupPayload: prompt.slice(0, 100)
    });
    
    // Construtor RegExp previne a quebra do parser de Markdown por crases
    const cleanContent = raw.content?.replace(new RegExp('\`\`\`json|\`\`\`', 'gi'), '').trim() || '{}';
    return safeParseJSON(cleanContent) as T;
  } catch (e) {
    console.error('[ExtractorAI] Falha na fila background:', e);
    return null;
  }
}

// ============================================================
// EXTRATOR: PROJETOS
// ============================================================
export async function extractProjeto(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia projetos ou ideias afirmados pelo USUÁRIO. Retorne APENAS JSON:
  Mensagem: "${userMessage}"
  {"projetos": [{"nome": null, "tag": null, "descricao": null, "status": null, "contexto_tecnico": null}]}
  REGRAS: tag em slug. status: "ideia"|"em_desenvolvimento"|"beta"|"producao"|"pausado"`;

  const data = await runExtractorAI<ExtractedProjetos>(userId, prompt, 20000);
  
  for (const proj of (data?.projetos || [])) {
    if (!proj.nome || !proj.tag) continue;
    await projectService.upsertProject(Number(userId), proj);
  }
}

// ============================================================
// EXTRATOR: EVENTOS GENÉRICOS E AGENDA
// ============================================================
export async function extractEvento(userId: string, userMessage: string): Promise<void> {
  const anoAtual = new Date().getFullYear();
  const prompt = `Extraia eventos. Mensagem: "${userMessage}" Ano: ${anoAtual}
  JSON: {"eventos": [{"titulo": null, "data": "YYYY-MM-DD", "tipo": null, "recorrente": false, "notas": null}]}`;

  const data = await runExtractorAI<ExtractedEventos>(userId, prompt, 15000);
  
  for (const ev of (data?.eventos || [])) {
    if (!ev.titulo || !ev.data) continue;
    await eventsService.processGenericEvent(Number(userId), ev);
  }
}

export async function extractAgenda(userId: string, userMessage: string): Promise<void> {
  const anoAtual = new Date().getFullYear();
  const prompt = `Extraia compromissos com data e hora explícitas. Mensagem: "${userMessage}"
  JSON: {"compromissos": [{"descricao": null, "data_hora": "ISO8601", "categoria": null, "aviso_minutos": 30}]}
  ANO ATUAL: ${anoAtual}. Exemplo: "sexta às 9h" -> "${anoAtual}-05-08T09:00:00-03:00"`;

  const data = await runExtractorAI<ExtractedAgenda>(userId, prompt, 20000);
  
  if (data?.compromissos?.length) {
    await eventsService.processAgendaEvents(Number(userId), data.compromissos, anoAtual);
  }
}

// ============================================================
// EXTRATOR: FAMÍLIA
// ============================================================
export async function extractFamilia(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia dados familiares. Mensagem: "${userMessage}"
  JSON: {"esposa": {"nome": null, "aniversario": null}, "filhos": [{"nome": null, "nascimento": null}], "pai": null, "mae": null}`;

  const data = await runExtractorAI<ExtractedFamilia>(userId, prompt, 20000);
  if (!data) return;

  const profile = await familyService.getCurrentProfile(userId);
  const conjuge = data.esposa?.nome ? data.esposa : data.marido?.nome ? data.marido : null;
  
  if (conjuge) await familyService.upsertSpouse(userId, conjuge, profile);
  if (data.filhos && Array.isArray(data.filhos)) {
    for (const filho of data.filhos) await familyService.upsertChild(userId, filho);
  }
  if (data.pai) await familyService.upsertParent(userId, data.pai, 'father_name', profile);
  if (data.mae) await familyService.upsertParent(userId, data.mae, 'mother_name', profile);
}

// ============================================================
// EXTRATOR: ROTINA E PREFERÊNCIAS
// ============================================================
export async function extractRotina(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia rotina. JSON: {"despertar": null, "dormir": null} Msg: "${userMessage}"`;
  const data = await runExtractorAI<ExtractedRotina>(userId, prompt, 10000);
  
  if (data?.despertar || data?.dormir) {
    await profileService.updateRoutine(Number(userId), data);
  }
}

export async function extractPreferencia(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia preferências. JSON: {"preferencias": [{"tipo": "lugar", "descricao": "X"}]} Msg: "${userMessage}"`;
  const data = await runExtractorAI<ExtractedPreferencia>(userId, prompt, 15000);
  
  if (data?.preferencias?.length) {
    await profileService.addPreferences(Number(userId), data.preferencias);
  }
}

// ============================================================
// EXTRATOR: COMPRAS & RECOMENDAÇÕES
// ============================================================
export async function extractShopping(userId: string, userMessage: string, aiReply: string = ''): Promise<void> {
  const prompt = `Extraia itens de compra. JSON: {"items": [{"item": "nome", "category": "mercado"}]} Msg: "${userMessage}" IA: "${aiReply}"`;
  const data = await runExtractorAI<ExtractedShopping>(userId, prompt, 15000);
  
  if (data?.items?.length) {
    await shoppingService.addItems(Number(userId), data.items);
  }
}

export async function extractRecomendacao(userId: string, userMessage: string, aiReply: string): Promise<void> {
  const prompt = `Extraia recomendações. JSON: {"recomendacoes": [{"tipo": "lugar", "nome": "X", "status": "pending"}]} Msg: "${userMessage}" IA: "${aiReply}"`;
  const data = await runExtractorAI<ExtractedRecomendacao>(userId, prompt, 15000);
  
  if (data?.recomendacoes?.length) {
    await recommendationsService.processRecommendations(Number(userId), data.recomendacoes);
  }
}

// ============================================================
// EXTRATOR: VALORES E PRINCÍPIOS MORAIS (Espelho Moral)
// ============================================================
export async function extractValores(userId: string, userMessage: string): Promise<void> {
  const prompt = `
  Você extrai princípios morais, regras de vida e visão de mundo do usuário.
  Mensagem: "${userMessage}"
  Retorne JSON: {"principios": [{"conteudo": null, "categoria": null, "tipo": "declaracao", "tags": ["palavra-chave"]}]}

  Regras do campo "tipo":
  - "declaracao": O usuário definiu uma regra de vida ou crença.
  - "amadurecimento": Mudança reflexiva e madura da regra.
  - "desculpa": Racionalização reativa para um erro emocional.

  Extraia "tags" com palavras-chave vitais (ex: "ansiedade", "casamento", "finanças").
  Só extraia se for um princípio universal para o usuário, não uma opinião genérica.
  `.trim();

  const data = await runExtractorAI<ExtractedValores>(userId, prompt, 15000);
  
  if (!data?.principios || data.principios.length === 0) return;

  for (const principio of data.principios) {
    if (!principio.conteudo || principio.tipo === 'desculpa') {
      console.log(`[Extractor] Princípio ignorado. Tipo: ${principio.tipo} | Conteúdo: ${principio.conteudo}`);
      continue;
    }

    try {
      await upsertPrinciple({
        userId: Number(userId),
        content: principio.conteudo,
        category: principio.categoria || 'Filosofia e Moral',
        source: 'extracted',
        confidenceDelta: 0.2,
        tags: principio.tags || []
      });
    } catch (e: any) {
      console.error('[Extractor] Falha ao salvar princípio:', e.message);
    }
  }
}