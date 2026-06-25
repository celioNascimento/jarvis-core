// lib/chat/pipeline/prompt-assembler.ts
// v7.2 — Knowledge base curada injetada no bloco de memória

import { loadActiveModules } from '@/lib/modules/registry';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import type { ChatPrompt } from './types';

// ── Blocos de prompt ──────────────────────────────────────────────────────────
import { buildIdentityPrompt } from './prompts/identity';
import { buildCriticalThinkingPrompt } from './prompts/critical-thinking';
import { buildActiveContextPrompt } from './prompts/active-context';
import { buildMemoryPrompt } from './prompts/memory';
import { buildMemoryHonestyPrompt } from './prompts/memory-honesty';
import { buildOperationalPrompt } from './prompts/operational';
import { buildMoralMirrorPrompt, EmotionalState } from './prompts/moral-mirror';
import { buildEmotionalProtocolPrompt } from './prompts/emotional-protocol';
import { buildIntellectualFrictionPrompt } from './prompts/intellectual-friction';
import { buildFewShotExamplesPrompt } from './prompts/few-shot-examples';

// ── Formatadores puros ────────────────────────────────────────────────────────
import {
  buildFamilyBlock,
  buildProfileBlock,
  buildConversationSummary,
  buildRecommendationsBlock,
  buildTopicBlock,
  buildRelatedTopicsString,
  buildUrgentesString,
  buildGuidelinesString,
  filterL3Content,
} from './prompts/formatters';

import { inferEmotionalStateFromHistory } from './utils/infer-emotional-state';

// ── Serviços externos ─────────────────────────────────────────────────────────
import { buildPersonalityBlock } from '@/lib/services/personality.service';
import { buildLearnedInsightsBlock, buildPersonalityFromContext } from '@/lib/Utils/ai-helpers';
import type { KnowledgeRecord } from '@/lib/data/knowledge.data';

// ── Constantes ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';
const ALWAYS_ON_TOOLS = ['web_pesquisar'] as const;

const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /fil[ho]a/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

// ── Helpers locais ────────────────────────────────────────────────────────────

function shouldIncludeFamilyContext(message: string, history: string): boolean {
  const isHighAlertMonth = [4, 7].includes(new Date().getMonth());
  const hasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(history + message));
  return isHighAlertMonth || hasFamilySignal;
}

/**
 * Formata os registros de knowledge base em um bloco de texto
 * para injetar no prompt — instruções de como aplicar o conhecimento curado.
 */
function buildKnowledgeBlock(records: KnowledgeRecord[]): string {
  if (!records || records.length === 0) return '';

  const examples = records.map((r, i) => {
    const teoria = r.teoria_principal ? ` [${r.teoria_principal}]` : '';
    const passo = r.passo_fluxo ? ` — passo ${r.passo_fluxo} do fluxo` : '';
    return `Exemplo ${i + 1}${teoria}${passo}:\nPergunta similar: "${r.input_exemplo}"\nResposta modelo:\n${r.output_ideal}`;
  }).join('\n\n');

  return `[CONHECIMENTO ESPECIALIZADO — PARENTALIDADE CONSCIENTE]
Encontrei referências relevantes ao que foi perguntado. Use-as como guia de abordagem — não copie literalmente, adapte ao contexto atual.

FLUXO OBRIGATÓRIO antes de sugerir qualquer técnica:
1. TRIAGEM (Shanker): É desobediência ou sobrecarga de estresse?
2. PING DO HARDWARE (Siegel): A amígdala disparou? Conecte antes de redirecionar.
3. CHECK DE RAM (Harvard): O comando é adequado para a idade?
4. PATCH (Greene): Só então negocie a execução.

${examples}

Aplique este fluxo na resposta. Nunca pule etapas para ir direto às técnicas.`;
}

// ── Builder do system prompt ──────────────────────────────────────────────────

function assembleSystemPrompt(parts: {
  nickname: string;
  dataHoraSP: string;
  geoBlock: string;
  gpsInstruction: string;
  alertaRadar: string | null;
  urgentes: string;
  relatedTopics: string;
  learnedInsightsBlock: string;
  profileBlock: string;
  familyBlock: string;
  personalityBlock: string;
  l3Content: string;
  plan: string;
  guidelines: string;
  conversationSummary: string;
  recommendationsBlock: string;
  topicsBlock: string;
  emotionalState: 'stable' | 'stressed' | 'vulnerable' | 'critical';
  principles: Array<{ content: string; category: string; confidence: number }>;
  moralMirrorEnabled: boolean;
  frictionEnabled: boolean;
  tradition: string;
  lastFrictionAt?: string;
  recurrentThemes: Record<string, number>;
  fewShotBlock: string;
  knowledgeBlock: string; // ← novo
}): string {
  const blocks = [

    // 1. Identidade e comportamento base
    buildIdentityPrompt(parts.nickname),

    // 2. Pensamento crítico e modo tutor
    buildCriticalThinkingPrompt(parts.nickname),

    // 3. Contexto ativo (tempo, geo, alertas)
    buildActiveContextPrompt({
      dataHoraSP: parts.dataHoraSP,
      geoBlock: parts.geoBlock,
      gpsInstruction: parts.gpsInstruction,
      alertaRadar: parts.alertaRadar,
      urgentes: parts.urgentes,
      relatedTopics: parts.relatedTopics,
    }),

    // 4. Memória e perfil
    buildMemoryPrompt({
      learnedInsightsBlock: parts.learnedInsightsBlock,
      profileBlock: parts.profileBlock,
      familyBlock: parts.familyBlock,
      personalityBlock: parts.personalityBlock,
      l3Content: parts.l3Content,
      conversationSummary: parts.conversationSummary,
      recommendationsBlock: parts.recommendationsBlock,
      topicsBlock: parts.topicsBlock,
    }),

    // 4b. Protocolo de honestidade sobre memória
    buildMemoryHonestyPrompt(),

    // 4c. Conhecimento curado por domínio (parentalidade, etc)
    //     Injetado depois da memória pessoal, antes do protocolo emocional
    //     para que o Lev saiba COMO responder antes de processar O QUE responder
    parts.knowledgeBlock,

    // 5. Protocolo emocional
    buildEmotionalProtocolPrompt({
      enabled: true,
      emotionalState: parts.emotionalState,
      recurrentThemes: parts.recurrentThemes,
    }),

    // 5b. Exemplos de tom por similaridade vetorial
    parts.fewShotBlock,

    // 6. Espelho moral (suspenso em crise)
    buildMoralMirrorPrompt({
      nickname: parts.nickname,
      enabled: parts.moralMirrorEnabled,
      emotionalState: parts.emotionalState,
      principles: parts.principles,
    }),

    // 7. Atrito intelectual (só em estado estável, throttle 6h)
    buildIntellectualFrictionPrompt({
      enabled: parts.frictionEnabled,
      frictionEnabled: parts.frictionEnabled,
      emotionalState: parts.emotionalState,
      tradition: parts.tradition as any,
      lastFrictionAt: parts.lastFrictionAt,
    }),

    // 8. Operacional (plano, diretrizes) — sempre por último
    buildOperationalPrompt({
      plan: parts.plan,
      guidelines: parts.guidelines,
    }),

  ].filter(Boolean);

  return blocks.join('\n\n---\n\n');
}

// ── Builder principal (export público) ───────────────────────────────────────

export async function buildChatPrompt(
  ctx: ChatRequestContext,
  intel: ChatIntelligence,
): Promise<ChatPrompt> {
  const { user, resolvedLocation, normalizedLocation, message } = ctx;
  const { contexts, emotional, masterContext, recentHistory } = intel;

  // ── Formatação de dados do masterContext (zero queries) ───────────────────
  const learnedInsightsBlock = buildLearnedInsightsBlock(masterContext?.insights || []);
  const personalitySettings = buildPersonalityFromContext(masterContext?.settings);
  const profileBlock = buildProfileBlock(masterContext?.profile);
  const personalityBlock = buildPersonalityBlock(personalitySettings);
  const familyBlock = buildFamilyBlock(
    masterContext?.persons || [],
    masterContext?.children || [],
  );
  const recommendationsBlock = buildRecommendationsBlock(masterContext);
  const topicsBlock = buildTopicBlock(masterContext);
  const urgentes = buildUrgentesString(masterContext);
  const guidelines = buildGuidelinesString(masterContext);
  const relatedTopics = buildRelatedTopicsString(masterContext);

  // ── Knowledge block (curado pelo dataset de parentalidade) ────────────────
  const knowledgeBlock = buildKnowledgeBlock(masterContext?.knowledge || []);

  // ── Cargas paralelas ──────────────────────────────────────────────────────
  const [moduleResult, dynamicResult, fewShotBlock] = await Promise.all([
    loadActiveModules(
      {
        userId: String(user.id),
        authUserId: user.auth_user_id,
        message,
        contexts,
        emotionalScore: emotional.score,
        location: normalizedLocation,
        masterContext,
      },
      user.plan,
      DEFAULT_MODEL,
    ),
    buildDynamicContext({
      userId: String(user.id),
      authUserId: user.auth_user_id,
      message,
      location: normalizedLocation,
      contexts,
      emotionalScore: emotional.score,
      masterContext,
    }),
    buildFewShotExamplesPrompt(message, intel.queryEmbedding),
  ]);

  const finalModel = moduleResult.resolvedModel || DEFAULT_MODEL;

  // ── Radar de proximidade ──────────────────────────────────────────────────
  let alertaRadar: string | null = null;

  if (masterContext?.radar_alert) {
    alertaRadar = `[ALERTA RADAR]: ${masterContext.radar_alert}`;
  } else if (resolvedLocation?.lat && resolvedLocation?.lng) {
    const radar = await verificarProximidade(
      String(user.id),
      Number(resolvedLocation.lat),
      Number(resolvedLocation.lng),
      masterContext,
    );
    if (radar.temAlerta) alertaRadar = `[ALERTA RADAR]: ${radar.mensagem}`;
  }

  // ── Contexto temporal e geográfico ───────────────────────────────────────
  const nowSP = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dataHoraSP = nowSP.toLocaleString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const geoBlock = buildGeoBlock(resolvedLocation);

  console.log('[PROMPT GEO]', {
    geoBlock,
    label: resolvedLocation?.label,
    city: resolvedLocation?.city,
  });

  const gpsInstruction = resolvedLocation
    ? ''
    : `[GPS]: Indisponível. Não faça suposições sobre localização do usuário.`;

  // ── L3 / Dossiê ───────────────────────────────────────────────────────────
  const historyText = recentHistory.map(h => h.content).join(' ');
  const includeFamily = shouldIncludeFamilyContext(message, historyText);
  const rawL3Text = masterContext?.dossier_summary || masterContext?.user?.current_context || '';
  const l3Filtered = filterL3Content(rawL3Text, includeFamily);
  const l3Content = l3Filtered.length > 4000
    ? l3Filtered.slice(0, 4000) + '... (resumo completo disponível em memória HD)'
    : l3Filtered;

  // ── Conversa atual ────────────────────────────────────────────────────────
  const conversationSummary = buildConversationSummary(
    intel.recentHistory,
    user.nickname || 'usuário',
  );

  // ── Dados dos módulos opcionais ───────────────────────────────────────────
  const emotionalState = inferEmotionalStateFromHistory(
    intel.recentHistory,
    ctx.message,
    (masterContext?.emotional_state || 'stable') as EmotionalState,
  );
  const principles = masterContext?.principles || [];
  const moralMirrorEnabled = masterContext?.modules?.moralMirror ?? false;
  const frictionEnabled = masterContext?.profile?.friction_enabled ?? false;
  const tradition = masterContext?.profile?.belief_tradition ?? 'undefined';
  const lastFrictionAt = masterContext?.profile?.last_friction_at;
  const recurrentThemes = masterContext?.recurrent_themes || {};

  // ── Montagem final ────────────────────────────────────────────────────────
  const systemPrompt = assembleSystemPrompt({
    nickname: user.nickname || 'usuário',
    dataHoraSP,
    geoBlock,
    gpsInstruction,
    alertaRadar,
    urgentes,
    relatedTopics,
    learnedInsightsBlock,
    profileBlock,
    familyBlock,
    personalityBlock,
    l3Content,
    plan: user.plan,
    guidelines,
    conversationSummary,
    recommendationsBlock,
    topicsBlock,
    emotionalState,
    principles,
    moralMirrorEnabled,
    frictionEnabled,
    tradition,
    lastFrictionAt,
    recurrentThemes,
    fewShotBlock,
    knowledgeBlock, // ← novo
  });

  // ── Ferramentas ───────────────────────────────────────────────────────────
  const allToolKeys = new Set<string>([
    ...ALWAYS_ON_TOOLS,
    ...(moduleResult.activeTools || []),
    ...(dynamicResult.activeTools || []),
  ]);

  const resolvedTools = ALL_TOOLS.filter(
    (t: any) => t.function?.name && allToolKeys.has(t.function.name),
  );

  return {
    systemPrompt,
    tools: resolvedTools,
    model: finalModel,
    conversationMessages: [
      ...recentHistory,
      { role: 'user', content: message },
    ],
  };
}