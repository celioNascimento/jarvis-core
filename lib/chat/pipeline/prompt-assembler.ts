// lib/chat/pipeline/prompt-assembler.ts
// v6.0 — Assembler como orquestrador puro
//
// REGRA DESTE ARQUIVO:
//   ✅ Importa blocos de /prompts/*
//   ✅ Importa formatadores de /formatters/*
//   ✅ Chama cargas paralelas (módulos, contexto dinâmico, radar)
//   ❌ Não define strings de prompt inline
//   ❌ Não contém lógica de formatação
//   ❌ Não acessa banco diretamente
//
// Se você está prestes a escrever uma string grande aqui → crie um arquivo em /prompts/

import { loadActiveModules }       from '@/lib/modules/registry';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext }     from '@/lib/chat/context-builder';
import { tools as ALL_TOOLS }      from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence }   from './intelligence';
import type { ChatPrompt }         from './types'; 

// ── Blocos de prompt ──────────────────────────────────────────────────────────
import { buildIdentityPrompt }              from './prompts/identity';
import { buildCriticalThinkingPrompt }      from './prompts/critical-thinking';
import { buildActiveContextPrompt }         from './prompts/active-context';
import { buildMemoryPrompt }                from './prompts/memory';
import { buildOperationalPrompt }           from './prompts/operational';
import { buildMoralMirrorPrompt }           from './prompts/moral-mirror';
import { buildEmotionalProtocolPrompt }     from './prompts/emotional-protocol';
import { buildIntellectualFrictionPrompt }  from './prompts/intellectual-friction';

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

// ── Serviços externos (sem mudança) ──────────────────────────────────────────
import { buildPersonalityBlock }                         from '@/lib/services/personality.service';
import { buildLearnedInsightsBlock, buildPersonalityFromContext } from '@/lib/Utils/ai-helpers';

// ── Constantes ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL   = 'google/gemini-2.0-flash-001';
const ALWAYS_ON_TOOLS = ['web_pesquisar'] as const;

const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /fil[ho]a/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

// ── Helpers locais (lógica de negócio, não formatação) ────────────────────────

function shouldIncludeFamilyContext(message: string, history: string): boolean {
  const isHighAlertMonth = [4, 7].includes(new Date().getMonth());
  const hasFamilySignal  = FAMILY_DATE_SIGNALS.some(p => p.test(history + message));
  return isHighAlertMonth || hasFamilySignal;
}

// ── Builder do system prompt ──────────────────────────────────────────────────
// Único lugar onde os blocos são ordenados e unidos.
// Ordem importa: identidade → contexto → memória → protocolos → operacional

function assembleSystemPrompt(parts: {
  nickname:             string;
  dataHoraSP:           string;
  geoBlock:             string;
  gpsInstruction:       string;
  alertaRadar:          string | null;
  urgentes:             string;
  relatedTopics:        string;
  learnedInsightsBlock: string;
  profileBlock:         string;
  familyBlock:          string;
  personalityBlock:     string;
  l3Content:            string;
  plan:                 string;
  guidelines:           string;
  conversationSummary:  string;
  recommendationsBlock: string;
  topicsBlock:          string;
  // módulos opcionais
  emotionalState:       'stable' | 'stressed' | 'vulnerable' | 'critical';
  principles:           Array<{ content: string; category: string; confidence: number }>;
  moralMirrorEnabled:   boolean;
  frictionEnabled:      boolean;
  tradition:            string;
  lastFrictionAt?:      string;
  recurrentThemes:      Record<string, number>;
}): string {
  const blocks = [

    // 1. Identidade e comportamento base
    buildIdentityPrompt(parts.nickname),

    // 2. Pensamento crítico e modo tutor
    buildCriticalThinkingPrompt(parts.nickname),

    // 3. Contexto ativo (tempo, geo, alertas)
    buildActiveContextPrompt({
      dataHoraSP:    parts.dataHoraSP,
      geoBlock:      parts.geoBlock,
      gpsInstruction:parts.gpsInstruction,
      alertaRadar:   parts.alertaRadar,
      urgentes:      parts.urgentes,
      relatedTopics: parts.relatedTopics,
    }),

    // 4. Memória e perfil
    buildMemoryPrompt({
      learnedInsightsBlock: parts.learnedInsightsBlock,
      profileBlock:         parts.profileBlock,
      familyBlock:          parts.familyBlock,
      personalityBlock:     parts.personalityBlock,
      l3Content:            parts.l3Content,
      conversationSummary:  parts.conversationSummary,
      recommendationsBlock: parts.recommendationsBlock,
      topicsBlock:          parts.topicsBlock,
    }),

    // 5. Protocolo emocional (calibra os módulos abaixo)
    buildEmotionalProtocolPrompt({
      enabled:         true,
      emotionalState:  parts.emotionalState,
      recurrentThemes: parts.recurrentThemes,
    }),

    // 6. Espelho moral (suspenso em crise)
    buildMoralMirrorPrompt({
      nickname:       parts.nickname,
      enabled:        parts.moralMirrorEnabled,
      emotionalState: parts.emotionalState,
      principles:     parts.principles,
    }),

    // 7. Atrito intelectual (só em estado estável, throttle 6h)
    buildIntellectualFrictionPrompt({
      enabled:         parts.frictionEnabled,
      frictionEnabled: parts.frictionEnabled,
      emotionalState:  parts.emotionalState,
      tradition:       parts.tradition as any,
      lastFrictionAt:  parts.lastFrictionAt,
    }),

    // 8. Operacional (plano, diretrizes) — sempre por último
    buildOperationalPrompt({
      plan:       parts.plan,
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
  const { contexts, emotional, masterContext, recentHistory }   = intel;

  // ── Formatação de dados do masterContext (zero queries) ───────────────────
  const learnedInsightsBlock = buildLearnedInsightsBlock(masterContext?.insights || []);
  const personalitySettings  = buildPersonalityFromContext(masterContext?.settings);
  const profileBlock         = buildProfileBlock(masterContext?.profile);
  const personalityBlock     = buildPersonalityBlock(personalitySettings);
  const familyBlock          = buildFamilyBlock(
    masterContext?.persons   || [],
    masterContext?.children  || [],
  );
  const recommendationsBlock = buildRecommendationsBlock(masterContext);
  const topicsBlock          = buildTopicBlock(masterContext);
  const urgentes             = buildUrgentesString(masterContext);
  const guidelines           = buildGuidelinesString(masterContext);
  const relatedTopics        = buildRelatedTopicsString(masterContext);

  // ── Cargas paralelas ──────────────────────────────────────────────────────
  const [moduleResult, dynamicResult] = await Promise.all([
    loadActiveModules(
      {
        userId:        String(user.id),
        authUserId:    user.auth_user_id,
        message,
        contexts,
        emotionalScore:emotional.score,
        location:      normalizedLocation,
        masterContext,
      },
      user.plan,
      DEFAULT_MODEL,
    ),
    buildDynamicContext({
      userId:        String(user.id),
      authUserId:    user.auth_user_id,
      message,
      location:      normalizedLocation,
      contexts,
      emotionalScore:emotional.score,
      masterContext,
    }),
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
  const nowSP      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dataHoraSP = nowSP.toLocaleString('pt-BR');
  const geoBlock   = buildGeoBlock(resolvedLocation);

  console.log('[PROMPT GEO]', {
    geoBlock,
    label: resolvedLocation?.label,
    city:  resolvedLocation?.city,
  });

  const gpsInstruction = resolvedLocation
    ? ''
    : `[GPS]: Indisponível. Não faça suposições sobre localização do usuário.`;

  // ── L3 / Dossiê ───────────────────────────────────────────────────────────
  const historyText  = recentHistory.map(h => h.content).join(' ');
  const includeFamily = shouldIncludeFamilyContext(message, historyText);
  const rawL3Text    = masterContext?.dossier_summary || masterContext?.user?.current_context || '';
  const l3Filtered   = filterL3Content(rawL3Text, includeFamily);
  const l3Content    = l3Filtered.length > 4000
    ? l3Filtered.slice(0, 4000) + '... (resumo completo disponível em memória HD)'
    : l3Filtered;

  // ── Conversa atual ────────────────────────────────────────────────────────
  const conversationSummary = buildConversationSummary(
    intel.recentHistory,
    user.nickname || 'usuário',
  );

  // ── Dados dos módulos opcionais (espelho, atrito) ─────────────────────────
  const emotionalState    = (masterContext?.emotional_state || 'stable') as any;
  const principles        = masterContext?.principles || [];
  const moralMirrorEnabled = masterContext?.modules?.moralMirror ?? false;
  const frictionEnabled   = masterContext?.profile?.friction_enabled ?? false;
  const tradition         = masterContext?.profile?.belief_tradition ?? 'undefined';
  const lastFrictionAt    = masterContext?.profile?.last_friction_at;
  const recurrentThemes   = masterContext?.recurrent_themes || {};

  // ── Montagem final ────────────────────────────────────────────────────────
  const systemPrompt = assembleSystemPrompt({
    nickname:             user.nickname || 'usuário',
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
    plan:                 user.plan,
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
  });

  // ── Ferramentas ───────────────────────────────────────────────────────────
  const allToolKeys = new Set<string>([
    ...ALWAYS_ON_TOOLS,
    ...(moduleResult.activeTools  || []),
    ...(dynamicResult.activeTools || []),
  ]);

  const resolvedTools = ALL_TOOLS.filter(
    (t: any) => t.function?.name && allToolKeys.has(t.function.name),
  );

  return {
    systemPrompt,
    tools:                resolvedTools,
    model:                finalModel,
    conversationMessages: [
      ...recentHistory,
      { role: 'user', content: message },
    ],
  };
}