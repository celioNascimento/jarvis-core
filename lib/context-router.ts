// ============================================================
// lib/context-router.ts
// Classificador temporal + roteador dinâmico de contexto
//
// Determina QUAIS camadas de memória usar e com QUANTO PESO
// baseado no horizonte temporal da mensagem do usuário.
// ============================================================

export type TemporalHorizon = 'immediate' | 'recent' | 'past' | 'distant';

export interface ContextWeights {
  horizon: TemporalHorizon;
  ram: number;       // histórico da sessão atual
  l3: number;        // dossiê do usuário
  hd: number;        // memórias vetorizadas
  ashes: number;     // cinzas (memórias comprimidas)
  events: number;    // eventos e datas
  reason: string;    // log do motivo
}

export interface BuiltContext {
  weights: ContextWeights;
  ramBlock: string;
  l3Block: string;
  hdBlock: string;
  ashesBlock: string;
  eventsBlock: string;
  promptContext: string;  // contexto final montado e ponderado
}

// ============================================================
// 1. CLASSIFICADOR TEMPORAL
// Detecta o horizonte temporal da mensagem
// ============================================================
export function classifyTemporalHorizon(
  message: string,
  ramHistory: string,
  pendingQuestion: string | null
): ContextWeights {

  const msg = message.toLowerCase();

  // ── IMEDIATO: está respondendo algo da conversa atual ──
  // Detecta respostas curtas, confirmações, continuações
  const isDirectReply =
    pendingQuestion !== null ||  // há pergunta aberta esperando resposta
    msg.length < 60 ||           // mensagem curta = provavelmente resposta
    /^(sim|não|nao|pode|claro|ok|beleza|isso|exato|talvez|não sei|acho que|uns?|umas?|tipo|quero|prefiro|gosto|ele|ela|eles|elas|o mesmo|a mesma|desse|dessa|aquele|aquela)\b/.test(msg);

  if (isDirectReply) {
    return {
      horizon: 'immediate',
      ram: 0.85,
      l3: 0.10,
      hd: 0.0,
      ashes: 0.0,
      events: 0.05,
      reason: pendingQuestion
        ? 'Resposta para pergunta pendente'
        : 'Mensagem curta — provavelmente continuação de conversa'
    };
  }

  // ── DISTANTE: referência a anos atrás, memórias antigas ──
  const distantPatterns = [
    /\b(ano retrasado|retrasado|anos atr[aá]s|h[aá] \d+ anos?|quando era (pequeno|crian[çc]a|novo))\b/,
    /\b(2019|2020|2021|2022|2023|201\d|200\d)\b/,
    /\b(natal de|ano novo de|carnaval de|f[eé]rias de) \d{4}/,
    /\b(lembra quando|voc[eê] lembra|ainda lembra|nunca esqueci|aquela vez que)\b/,
    /\b(minha inf[aâ]ncia|quando eu era|no tempo que|naquela [eé]poca)\b/,
  ];

  if (distantPatterns.some(p => p.test(msg))) {
    return {
      horizon: 'distant',
      ram: 0.0,
      l3: 0.10,
      hd: 0.30,
      ashes: 0.60,
      events: 0.0,
      reason: 'Referência a período distante — priorizando HD e Cinzas'
    };
  }

  // ── PASSADO RECENTE: semanas/meses atrás ──
  const pastPatterns = [
    /\b(semana passada|m[eê]s passado|m[eê]s anterior|no m[eê]s de|faz (uma|duas|tr[eê]s|algumas) semanas?)\b/,
    /\b(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/,
    /\b(ontem|anteontem|faz (uns?|umas?) (dias?|tempo))\b/,
    /\b(naquela conversa|falamos sobre|voc[eê] (me )?disse|eu (te )?falei)\b/,
    /\b(quando comecei|quando entrei|quando mudei|quando aconteceu)\b/,
  ];

  if (pastPatterns.some(p => p.test(msg))) {
    return {
      horizon: 'past',
      ram: 0.15,
      l3: 0.35,
      hd: 0.45,
      ashes: 0.05,
      events: 0.0,
      reason: 'Referência a período recente-passado — priorizando L3 e HD'
    };
  }

  // ── RECENTE: menção explícita a datas, pessoas ou compromissos ──
  const recentPatterns = [
    /\b(hoje|agora|esta semana|essa semana|nessa semana|esta manhã|essa manhã)\b/,
    /\b(meu (projeto|trabalho|emprego|treino|rotina))\b/,
    /\b(white martins|procuro quem fa[çc]a|expertfrotas)\b/,
    /\b(minha (esposa|mulher|filh[oa]|m[ãa]e|pai|fam[íi]lia))\b/,
    /\b(aniversário|presente|data|quando [ée]|me lembra|sabe quando)\b/,
  ];

  if (recentPatterns.some(p => p.test(msg))) {
    return {
      horizon: 'recent',
      ram: 0.25,
      l3: 0.40,
      hd: 0.20,
      ashes: 0.0,
      events: 0.15,
      reason: 'Contexto recente com referência a datas ou pessoas'
    };
  }

  // ── DEFAULT: conversa casual — eventos fora, foco na conversa ──
  return {
    horizon: 'recent',
    ram: 0.50,
    l3: 0.35,
    hd: 0.15,
    ashes: 0.0,
    events: 0.0,  // eventos só entram quando explicitamente relevantes
    reason: 'Conversa casual — RAM e L3 dominam, sem eventos'
  };
}


// ============================================================
// 2. CONSTRUTOR DE CONTEXTO PONDERADO
// Monta o bloco de contexto final para o prompt
// baseado nos pesos calculados pelo classificador
// ============================================================
export function buildWeightedContext(
  weights: ContextWeights,
  data: {
    ram: string;
    l3: string;
    hd: string;
    ashes: string | null;
    events: string;
    authorName: string;
    pendingQuestion: string | null;
    pendingContext: any;
  }
): string {

  const sections: string[] = [];

  // ── L3: Dossiê ──
  if (weights.l3 > 0 && data.l3 && data.l3 !== "Sem dossiê ainda.") {
    if (weights.horizon === 'immediate') {
      // No modo imediato, só injeta um resumo curto do dossiê
      const l3Lines = data.l3.split('\n').slice(0, 8).join('\n');
      sections.push(`[PERFIL RESUMIDO]\n${l3Lines}`);
    } else {
      sections.push(`[DOSSIÊ — QUEM É ${data.authorName.toUpperCase()}]\n${data.l3}`);
    }
  }

  // ── RAM: Histórico da sessão ──
  if (weights.ram > 0 && data.ram) {
    const label = weights.horizon === 'immediate'
      ? '⭐ [CONVERSA ATUAL — ALTA PRIORIDADE]'
      : '[HISTÓRICO RECENTE]';
    sections.push(`${label}\n${data.ram}`);
  }

  // ── HD: Memórias vetorizadas ──
  if (weights.hd > 0 && data.hd) {
    sections.push(`[MEMÓRIAS DE LONGO PRAZO]\n${data.hd}`);
  }

  // ── Cinzas: só no modo distante ──
  if (weights.ashes > 0 && data.ashes) {
    sections.push(
      `[MEMÓRIAS DISTANTES — use "lembro vagamente que..." ao citar]\n${data.ashes}`
    );
  }

  // ── Events: só quando relevante ──
  if (weights.events > 0 && data.events && !data.events.includes("Nenhum evento")) {
    sections.push(`[EVENTOS E DATAS IMPORTANTES]\n${data.events}`);
  }

  // ── Pergunta pendente: sempre no final, com destaque ──
  if (data.pendingQuestion) {
    sections.push(
      `⚠️ [PERGUNTA PENDENTE AGUARDANDO RESPOSTA]\n` +
      `Pergunta: "${data.pendingQuestion}"\n` +
      `Contexto: ${JSON.stringify(data.pendingContext)}\n` +
      `INSTRUÇÃO CRÍTICA: A mensagem atual É a resposta para essa pergunta. ` +
      `Resolva ISSO PRIMEIRO antes de qualquer outro assunto. ` +
      `Após resolver, use [LIMPAR_PENDENTE].`
    );
  }

  return sections.join('\n\n═══════════════════════════════════════\n\n');
}


// ============================================================
// 3. HELPER: Trunca contexto por peso relativo
// Garante que camadas com peso maior ganhem mais tokens
// ============================================================
export function truncateByWeight(
  text: string,
  weight: number,
  maxTotalChars: number = 6000
): string {
  if (!text || weight === 0) return '';
  const maxChars = Math.floor(maxTotalChars * weight);
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars) + '\n[... truncado por limite de contexto]';
}
