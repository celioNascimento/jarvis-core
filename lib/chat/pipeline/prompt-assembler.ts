// lib/chat/pipeline/prompt-assembler.ts
// v13.0 — Prompt com orçamento fixo para a Modal (contexto de 4096 tokens).
//
// Regra: só vai para a Modal o que a mensagem pede.
//   • Sempre:     persona curta + data/hora + perfil + família + histórico recente ("RAM") + pergunta.
//   • Por tag:    memórias/dossiê, agenda/lembretes urgentes, localização, tópicos relacionados.
//   • Por mensagem: ferramentas dos grupos citados (agenda, compras, projetos…); nunca as 29 de uma vez.
//   • Sobrou espaço: exemplos de tom (few-shot) e o exemplo de conhecimento curado.
// Os limites e o corte ficam em prompt-budget.ts; o lev-gateway.ts ainda confere o total antes de enviar.

import { loadActiveModules } from '@/lib/modules/registry';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import type { ChatPrompt } from './types';

import type { EmotionalState } from './prompts/moral-mirror';
import { buildFewShotExamplesPrompt } from './prompts/few-shot-examples';
import {
  buildFamilyBlock,
  buildProfileBlock,
  buildRecommendationsBlock,
  buildTopicBlock,
  buildRelatedTopicsString,
  buildUrgentesString,
  buildGuidelinesString,
  filterL3Content,
} from './prompts/formatters';

import { inferEmotionalStateFromHistory } from './utils/infer-emotional-state';
import { shouldPrefetchPersonalMemory } from './utils/personal-memory';
import { buildLearnedInsightsBlock } from '@/lib/Utils/ai-helpers';
import {
  type ContextBlock,
  MAX_USER_MESSAGE_CHARS,
  MESSAGE_OVERHEAD_TOKENS,
  estimateJsonTokens,
  estimateTokens,
  fitBlocks,
  historyShare,
  promptBudgetTokens,
  selectHistory,
  selectTools,
  truncateToTokens,
} from './prompt-budget';

const DEFAULT_MODEL = process.env.HF_MODEL_ID || 'celioNascimento/Lev-LoRA-Orquestrador-Merged-v2';
const ALWAYS_ON_TOOLS = ['web_pesquisar'] as const;
const TOOLS_MAX_TOKENS = 1500;
const FEW_SHOT_MIN_ROOM_TOKENS = 450;

const CONTEXT_FIELDS: Record<string, string[]> = {
  agenda: ['events', 'calendar_block', 'reminders', 'related_topics'],
  evento: ['events', 'calendar_block', 'reminders', 'related_topics'],
  rotina: ['routines', 'related_topics'],
  foco: ['routines', 'related_topics'],
  financas: ['budgets', 'shopping', 'related_topics'],
  compras: ['shopping', 'related_topics'],
  projeto: ['projects', 'related_topics'],
  trabalho: ['projects', 'calendar_block', 'related_topics'],
  veiculos: ['vehicles', 'vehicle_maintenances', 'vehicle_refuels', 'related_topics'],
  diario: ['diary', 'related_topics'],
  familia: ['persons', 'children', 'related_topics'],
  filhos: ['children', 'related_topics'],
  emocao: ['emotional_state', 'insights', 'related_topics'],
  saude: ['health', 'related_topics'],
  localizacao: ['locations', 'related_topics'],
};

const LOCATION_SIGNAL = /onde (eu )?(estou|tô|to)\b|aqui|perto|cidade|endere[çc]o|rota|tr[âa]nsito|clima|previs[ãa]o|chover|calor|frio/i;
const TECH_SIGNAL = /erro|bug|c[óo]digo|fun[çc][ãa]o|deploy|timeout|stack|build|api\b|query|commit/i;
const RECOMMEND_SIGNAL = /recomend|indica|sugere|dica de|o que (assistir|ler|ouvir)/i;

function isRelevantText(value: unknown, tags: Set<string>): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return [...tags].some(tag => text.toLowerCase().includes(tag.toLowerCase()));
}

function scopeContextToTags(masterContext: any, contexts: string[]): any {
  if (!masterContext || contexts.length === 0) return masterContext;
  const tags = new Set(contexts.map(tag => tag.toLowerCase()));
  const allowed = new Set(contexts.flatMap(tag => CONTEXT_FIELDS[tag] || []));
  const scoped = { ...masterContext };

  for (const field of ['events', 'calendar_block', 'routines', 'budgets', 'projects', 'vehicles', 'vehicle_maintenances', 'vehicle_refuels', 'diary', 'health']) {
    if (!allowed.has(field)) delete scoped[field];
  }
  if (Array.isArray(masterContext.insights)) {
    scoped.insights = masterContext.insights.filter((item: unknown) => isRelevantText(item, tags));
  }
  if (Array.isArray(masterContext.related_topics)) {
    scoped.related_topics = masterContext.related_topics.filter((item: unknown) => isRelevantText(item, tags));
  }
  return scoped;
}

/** "quinta-feira, 22 de outubro de 2026 às 14:05" — mesmo formato do dataset de treino. */
function formatNowSP(): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('weekday')}, ${get('day')} de ${get('month')} de ${get('year')} às ${get('hour')}:${get('minute')}`;
}

const EMOTIONAL_GUIDANCE: Partial<Record<string, string>> = {
  stressed: 'O usuário parece estressado: seja breve e prático, sem piada pesada.',
  vulnerable: 'O usuário parece fragilizado: baixe o tom, acolha de verdade, sem piada e sem sugestão prática que ele não pediu.',
  critical: 'O usuário pode estar em crise: sem humor e sem ferramentas. Frases curtas, presença, uma pergunta direta sobre segurança, CVV 188 (e SAMU 192 se houver risco imediato).',
};

/** Persona curta — espelha o SYSTEM_TEMPLATE do dataset de treino (ver lev-seed). */
function buildCorePrompt(opts: { nickname: string; hasTools: boolean; hasWebTool: boolean; technical: boolean; emotionalState: string }): string {
  const lines = [
    `Você é o Lev, amigo próximo de ${opts.nickname}. Fala como brasileiro de 30 e poucos anos: direto, informal, com opinião própria e humor ácido na medida.`,
    '',
    'COMO FALAR:',
    '- Curto, tipo mensagem de WhatsApp. Só alongue se o assunto pedir.',
    '- O humor vem da situação (ironia, exagero, zoar de volta quando o usuário brinca). Não force piada.',
    '- Gíria leve, no máximo uma por mensagem, sem repetir sempre a mesma.',
    '- Se o usuário estiver mal, baixa o tom e acolhe de verdade, sem piada.',
    '- Em crise (fala em morrer, sumir, se machucar): frases curtas, presença, uma pergunta direta sobre segurança, CVV 188 (e SAMU 192 se houver risco imediato). Sem humor e sem ferramentas.',
    '- NUNCA aja como terapeuta, coach ou assistente de IA. Nada de "como posso ajudar", "sinto muito", "é importante" ou "é compreensível".',
    '- Assunto encerrado ("valeu", "combinado", "pode deixar"): uma frase e para.',
    '- Só afirme o que está no contexto abaixo. Se a informação não está aqui, diga que não tem.',
  ];
  if (opts.hasTools) {
    lines.push(
      '',
      'FERRAMENTAS:',
      '- Use as ferramentas quando o usuário pedir uma ação ou um dado delas.',
      '- Ao chamar uma ferramenta, escreva só uma frase curta antes, sem dizer que já deu certo. Depois do resultado, confirme em uma frase com personalidade.',
      '- Se a ferramenta devolver erro ou conflito, diga o que houve sem enrolar e ofereça o próximo passo.',
      '- Perfil e família abaixo você já tem: responda direto, sem ferramenta.',
    );
    if (opts.hasWebTool) {
      lines.push('- Fato que depende da data atual (jogos, notícias, cotações): use web_pesquisar, nunca responda de cabeça.');
    }
  }
  if (opts.technical) {
    lines.push('', 'PEDIDO TÉCNICO: confirme em poucas palavras, entregue a solução com o local exato e finalize com "Pronto para testar?". Erro: [CAUSA] → [LOCAL] → [SOLUÇÃO].');
  }
  const guidance = EMOTIONAL_GUIDANCE[opts.emotionalState];
  if (guidance) lines.push('', guidance);
  return lines.join('\n');
}

export async function buildChatPrompt(
  ctx: ChatRequestContext,
  intel: ChatIntelligence,
): Promise<ChatPrompt> {
  const { user, resolvedLocation, normalizedLocation, message } = ctx;
  const { contexts, emotional, masterContext, recentHistory } = intel;
  const nickname = user.nickname || 'Célio';
  const hasContextTag = contexts.length > 0;
  const tagSet = new Set(contexts.map(t => t.toLowerCase()));
  const relevantContext = scopeContextToTags(masterContext, contexts);
  const isPersonalFact = shouldPrefetchPersonalMemory(message);

  // ── 1. FERRAMENTAS E MÓDULOS ───────────────────────────────────────────────
  const [moduleResult, dynamicResult] = await Promise.all([
    loadActiveModules({ userId: String(user.id), authUserId: user.auth_user_id, message, contexts, emotionalScore: emotional.score, location: normalizedLocation, masterContext }, user.plan, DEFAULT_MODEL),
    buildDynamicContext({ userId: String(user.id), authUserId: user.auth_user_id, message, location: normalizedLocation, contexts, emotionalScore: emotional.score, masterContext }),
  ]);
  const finalModel = moduleResult.resolvedModel || DEFAULT_MODEL;

  const emotionalState = inferEmotionalStateFromHistory(
    recentHistory, message, (masterContext?.emotional_state || 'stable') as EmotionalState,
  );
  const crisis = emotionalState === 'critical';

  const allToolKeys = new Set<string>([...ALWAYS_ON_TOOLS, ...(moduleResult.activeTools || []), ...(dynamicResult.activeTools || [])]);
  const candidateTools = ALL_TOOLS.filter((t: any) => t.function?.name && allToolKeys.has(t.function.name));
  // Perguntas pessoais (família/perfil) e crise não usam ferramentas (o orquestrador também não as envia).
  const toolSelection = isPersonalFact || crisis
    ? { tools: [] as any[], groups: [], tokens: 0, dropped: [] as string[] }
    : selectTools(candidateTools, message, contexts, recentHistory, TOOLS_MAX_TOKENS);
  const resolvedTools = toolSelection.tools;
  const hasTools = resolvedTools.length > 0;
  const hasWebTool = resolvedTools.some((t: any) => t.function?.name === 'web_pesquisar');

  // ── 2. NÚCLEO + PERGUNTA (partes fixas) ───────────────────────────────────
  const core = buildCorePrompt({
    nickname, hasTools, hasWebTool, technical: TECH_SIGNAL.test(message), emotionalState,
  });
  const userMessage = message.slice(0, MAX_USER_MESSAGE_CHARS);
  const total = promptBudgetTokens(hasTools);
  const fixedTokens = estimateTokens(core) + estimateJsonTokens(resolvedTools) + estimateTokens(userMessage) + 12;
  const remaining = Math.max(0, total - fixedTokens);

  // ── 3. HISTÓRICO RECENTE ("RAM") — sempre ─────────────────────────────────
  const history = selectHistory(recentHistory, historyShare(remaining));
  const historyTokens = history.reduce((sum, m) => sum + estimateTokens(m.content) + MESSAGE_OVERHEAD_TOKENS, 0);
  const blocksBudget = Math.max(0, remaining - historyTokens);

  // ── 4. BLOCOS DE CONTEXTO (por prioridade) ────────────────────────────────
  const profileBlock = buildProfileBlock(masterContext?.profile).replace(/^\[PERFIL PESSOAL\]\n?/, '');
  const familyBlock = buildFamilyBlock(masterContext?.persons || [], masterContext?.children || []).replace(/^\[FAMÍLIA\]\n?/, '');

  const familyHistory = history.map(h => h.content).join(' ');
  const includeFamilyInDossier = isPersonalFact || tagSet.has('familia') || tagSet.has('filhos') || /anivers|filh[oa]|espos|marid/i.test(message + familyHistory);
  const rawL3 = hasContextTag ? relevantContext?.dossier_summary || relevantContext?.user?.current_context || '' : '';
  const l3Content = filterL3Content(rawL3, includeFamilyInDossier);
  const insights = hasContextTag ? buildLearnedInsightsBlock(relevantContext?.insights || []) : '';

  const wantsAgendaItems = ['agenda', 'evento', 'rotina', 'trabalho'].some(t => tagSet.has(t));
  const urgentes = wantsAgendaItems ? buildUrgentesString(relevantContext) : '';
  const wantsLocation = tagSet.has('localizacao') || LOCATION_SIGNAL.test(message);
  const geoBlock = wantsLocation ? buildGeoBlock(resolvedLocation) : '';

  let alertaRadar: string | null = null;
  if (masterContext?.radar_alert) {
    alertaRadar = masterContext.radar_alert;
  } else if (wantsLocation && resolvedLocation?.lat && resolvedLocation?.lng) {
    const radar = await verificarProximidade(String(user.id), Number(resolvedLocation.lat), Number(resolvedLocation.lng), masterContext);
    if (radar.temAlerta) alertaRadar = radar.mensagem;
  }

  const rawGuidelines = buildGuidelinesString(relevantContext);
  const guidelines = rawGuidelines === 'Progresso contínuo' ? '' : rawGuidelines;

  const cap = (text: string, tokens: number) => (text ? truncateToTokens(text, tokens) : '');
  const blocks: ContextBlock[] = [
    { key: 'hoje', priority: 0, text: `[CONTEXTO ATIVO]\nHoje é ${formatNowSP()}.` },
    { key: 'perfil', priority: 1, minTokens: 60, text: `[PERFIL DO USUÁRIO]\nNome: ${nickname}\n${cap(profileBlock, 220)}` },
    { key: 'familia', priority: 2, minTokens: 30, text: `[FAMÍLIA]\n${cap(familyBlock, 160) || 'Nenhum familiar registrado no momento.'}` },
    { key: 'diretrizes', priority: 3, minTokens: 40, text: guidelines ? `[DIRETRIZES DO USUÁRIO]\n${cap(guidelines, 150)}` : '' },
    { key: 'radar', priority: 4, text: alertaRadar ? `[ALERTA RADAR]: ${cap(alertaRadar, 60)}` : '' },
    { key: 'urgentes', priority: 5, minTokens: 30, text: urgentes ? `[LEMBRETES URGENTES]\n${cap(urgentes, 120)}` : '' },
    { key: 'local', priority: 6, minTokens: 30, text: geoBlock ? `[LOCALIZAÇÃO]\n${cap(geoBlock, 100)}` : '' },
    { key: 'memorias', priority: 7, minTokens: 150, text: l3Content ? `[MEMÓRIAS RECUPERADAS]\n${cap(l3Content, 700)}` : '' },
    { key: 'insights', priority: 8, minTokens: 60, text: insights ? cap(insights, 200) : '' },
    { key: 'relacionados', priority: 9, minTokens: 40, text: hasContextTag ? cap(buildRelatedTopicsString(relevantContext), 100) && `[TÓPICOS RELACIONADOS]\n${cap(buildRelatedTopicsString(relevantContext), 100)}` : '' },
    { key: 'topicos', priority: 10, minTokens: 40, text: hasContextTag ? cap(buildTopicBlock(relevantContext), 100) : '' },
    { key: 'recomendacoes', priority: 11, minTokens: 60, text: hasContextTag && RECOMMEND_SIGNAL.test(message) ? cap(buildRecommendationsBlock(relevantContext), 200) : '' },
  ];

  const fitted = fitBlocks(blocks, blocksBudget);
  let contextText = fitted.text;
  let leftover = blocksBudget - estimateTokens(contextText);

  // ── 5. EXTRAS SÓ SE SOBRAR ESPAÇO ─────────────────────────────────────────
  let fewShotBlock = '';
  if (leftover >= FEW_SHOT_MIN_ROOM_TOKENS && !hasTools && !crisis) {
    const raw = await buildFewShotExamplesPrompt(message, intel.queryEmbedding).catch(() => '');
    const costFewShot = estimateTokens(raw) + 4;
    if (raw && costFewShot <= leftover - 150) {
      fewShotBlock = `[EXEMPLOS DE TOM]\n${raw}`;
      leftover -= costFewShot;
    }
  }
  if (fewShotBlock) contextText = `${contextText}\n\n${fewShotBlock}`;

  const knowledgeExample = (masterContext?.knowledge ?? [])[0] ?? null;
  const conversationMessages: any[] = [...history];
  if (knowledgeExample?.input_exemplo && knowledgeExample?.output_ideal) {
    const pair = `${knowledgeExample.input_exemplo}${knowledgeExample.output_ideal}`;
    if (estimateTokens(pair) + 10 <= leftover) {
      conversationMessages.push({ role: 'user', content: knowledgeExample.input_exemplo });
      conversationMessages.push({ role: 'assistant', content: knowledgeExample.output_ideal });
    }
  }
  conversationMessages.push({ role: 'user', content: userMessage });

  const systemPrompt = `${core}\n\n${contextText}`.trim();

  const totalTokens =
    estimateTokens(systemPrompt) + estimateJsonTokens(resolvedTools) +
    conversationMessages.reduce((sum, m) => sum + estimateTokens(m.content) + MESSAGE_OVERHEAD_TOKENS, 0);
  console.log(
    `[Prompt] ~${totalTokens}/${total} tokens | system ${estimateTokens(systemPrompt)} | ferramentas ${resolvedTools.length}` +
      ` (~${estimateJsonTokens(resolvedTools)}; grupos: ${toolSelection.groups.join(',') || '-'}) | histórico ${history.length}/${recentHistory.length} msgs` +
      ` | blocos: ${fitted.included.join(',') || '-'}${fitted.dropped.length ? ` | descartados: ${fitted.dropped.join(',')}` : ''}`,
  );

  return {
    systemPrompt,
    tools: resolvedTools,
    model: finalModel,
    conversationMessages,
  };
}
