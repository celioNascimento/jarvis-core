// lib/chat/pipeline/prompt-assembler.ts
// v11.0 — Resgate Total (ActiveContext + MemoryPrompt) + Formato de Treino Qwen

import { loadActiveModules } from '@/lib/modules/registry';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import type { ChatPrompt } from './types';

// Blocos de prompt originais
import { buildIdentityPrompt } from './prompts/identity';
import { buildCriticalThinkingPrompt } from './prompts/critical-thinking';
import { buildActiveContextPrompt } from './prompts/active-context'; // RESGATADO
import { buildMemoryPrompt } from './prompts/memory'; // RESGATADO
import { buildMemoryHonestyPrompt } from './prompts/memory-honesty';
import { buildEmotionalProtocolPrompt } from './prompts/emotional-protocol';
import { buildMoralMirrorPrompt, EmotionalState } from './prompts/moral-mirror';
import { buildIntellectualFrictionPrompt } from './prompts/intellectual-friction';
import { buildOperationalPrompt } from './prompts/operational';
import { buildFewShotExamplesPrompt } from './prompts/few-shot-examples';

// Formatadores originais
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
import { buildPersonalityBlock } from '@/lib/services/personality.service';
import { buildLearnedInsightsBlock, buildPersonalityFromContext } from '@/lib/Utils/ai-helpers';

const DEFAULT_MODEL = process.env.HF_MODEL_ID || 'celioNascimento/Lev-LoRA-Orquestrador';
const ALWAYS_ON_TOOLS = ['web_pesquisar'] as const;
const FAMILY_DATE_SIGNALS = [/aniversário/i, /casamento/i, /fil[ho]a/i, /esposa|marido/i];

function shouldIncludeFamilyContext(message: string, history: string): boolean {
  const isHighAlertMonth = [4, 7].includes(new Date().getMonth());
  const hasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(history + message));
  return isHighAlertMonth || hasFamilySignal;
}

export async function buildChatPrompt(
  ctx: ChatRequestContext,
  intel: ChatIntelligence,
): Promise<ChatPrompt> {
  const { user, resolvedLocation, normalizedLocation, message } = ctx;
  const { contexts, emotional, masterContext, recentHistory } = intel;

  // ── 1. RESGATE DE DADOS E BLOCOS ──────────────────────────────────────────
  const profileBlock = buildProfileBlock(masterContext?.profile);
  const familyBlock = buildFamilyBlock(masterContext?.persons || [], masterContext?.children || []);
  const topicsBlock = buildTopicBlock(masterContext);
  const urgentes = buildUrgentesString(masterContext);
  const guidelines = buildGuidelinesString(masterContext);
  const learnedInsightsBlock = buildLearnedInsightsBlock(masterContext?.insights || []);
  const personalitySettings = buildPersonalityFromContext(masterContext?.settings);
  const personalityBlock = buildPersonalityBlock(personalitySettings);
  const recommendationsBlock = buildRecommendationsBlock(masterContext);
  const relatedTopics = buildRelatedTopicsString(masterContext);

  // ── 2. CONTEXTO TEMPORAL E RADAR ──────────────────────────────────────────
  const nowSP = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dataHoraSP = nowSP.toLocaleString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const geoBlock = buildGeoBlock(resolvedLocation);
  const gpsInstruction = resolvedLocation ? '' : `[GPS]: Indisponível. Não faça suposições.`;
  
  let alertaRadar: string | null = null;
  if (masterContext?.radar_alert) {
    alertaRadar = `[ALERTA RADAR]: ${masterContext.radar_alert}`;
  } else if (resolvedLocation?.lat && resolvedLocation?.lng) {
    const radar = await verificarProximidade(String(user.id), Number(resolvedLocation.lat), Number(resolvedLocation.lng), masterContext);
    if (radar.temAlerta) alertaRadar = `[ALERTA RADAR]: ${radar.mensagem}`;
  }

  // ── 3. L3, HISTÓRICO E ESTADOS ────────────────────────────────────────────
  const historyText = recentHistory.map(h => h.content).join(' ');
  const includeFamily = shouldIncludeFamilyContext(message, historyText);
  const rawL3Text = masterContext?.dossier_summary || masterContext?.user?.current_context || '';
  const l3Content = filterL3Content(rawL3Text, includeFamily).slice(0, 4000);
  const conversationSummary = buildConversationSummary(intel.recentHistory, user.nickname || 'usuário');

  const emotionalState = inferEmotionalStateFromHistory(
    intel.recentHistory, ctx.message, (masterContext?.emotional_state || 'stable') as EmotionalState
  );
  const principles = masterContext?.principles || [];
  const moralMirrorEnabled = masterContext?.modules?.moralMirror ?? false;
  const frictionEnabled = masterContext?.profile?.friction_enabled ?? false;
  const tradition = masterContext?.profile?.belief_tradition ?? 'undefined';
  const lastFrictionAt = masterContext?.profile?.last_friction_at;
  const recurrentThemes = masterContext?.recurrent_themes || {};

  // ── 4. CARGAS PARALELAS ───────────────────────────────────────────────────
  const [moduleResult, dynamicResult, fewShotBlock] = await Promise.all([
    loadActiveModules({ userId: String(user.id), authUserId: user.auth_user_id, message, contexts, emotionalScore: emotional.score, location: normalizedLocation, masterContext }, user.plan, DEFAULT_MODEL),
    buildDynamicContext({ userId: String(user.id), authUserId: user.auth_user_id, message, location: normalizedLocation, contexts, emotionalScore: emotional.score, masterContext }),
    buildFewShotExamplesPrompt(message, intel.queryEmbedding),
  ]);

  const finalModel = moduleResult.resolvedModel || DEFAULT_MODEL;
  const knowledgeExample = (masterContext?.knowledge ?? [])[0] ?? null;

  // ── 5. MONTAGEM DO PROMPT FINAL (HÍBRIDO TOTAL) ───────────────────────────
  // Usamos os blocos originais e injetamos as tags que o Qwen Fine-Tuned aprendeu.
  const levSystemPrompt = `
Você é Lev, um amigo inteligente e natural. 
NUNCA aja como terapeuta genérico, coach ou assistente. NUNCA diga "não tenho acesso a registros".
Você TEM ACESSO à agenda, memórias e dados do usuário listados abaixo. Use as ferramentas se precisar agir.

${buildIdentityPrompt(user.nickname || 'Célio')}

${buildActiveContextPrompt({
  dataHoraSP: dataHoraSP,
  geoBlock: geoBlock,
  gpsInstruction: gpsInstruction,
  alertaRadar: alertaRadar,
  urgentes: urgentes,
  relatedTopics: relatedTopics,
})}

${buildMemoryPrompt({
  learnedInsightsBlock: `\n[MEMÓRIAS RECUPERADAS E INSIGHTS]\n${learnedInsightsBlock}\n${l3Content}`,
  profileBlock: profileBlock,
  familyBlock: familyBlock,
  personalityBlock: personalityBlock,
  l3Content: l3Content,
  conversationSummary: conversationSummary,
  recommendationsBlock: recommendationsBlock,
  topicsBlock: topicsBlock,
})}

${buildEmotionalProtocolPrompt({ enabled: true, emotionalState, recurrentThemes })}
${buildMemoryHonestyPrompt()}
${buildMoralMirrorPrompt({ nickname: user.nickname || 'Célio', enabled: moralMirrorEnabled, emotionalState, principles })}
${buildIntellectualFrictionPrompt({ enabled: frictionEnabled, frictionEnabled, emotionalState, tradition: tradition as any, lastFrictionAt })}
${buildOperationalPrompt({ plan: user.plan, guidelines })}

[EXEMPLOS DE TOM E CONTEXTO]
${fewShotBlock}
  `.trim();

  // ── 6. FERRAMENTAS ────────────────────────────────────────────────────────
  const allToolKeys = new Set<string>([...ALWAYS_ON_TOOLS, ...(moduleResult.activeTools || []), ...(dynamicResult.activeTools || [])]);
  const resolvedTools = ALL_TOOLS.filter((t: any) => t.function?.name && allToolKeys.has(t.function.name));

  // ── 7. HISTÓRICO DE MENSAGENS (COM KNOWLEDGE RAG) ─────────────────────────
  const conversationMessages: any[] = [...recentHistory];
  
  if (knowledgeExample) {
    conversationMessages.push({ role: 'user', content: knowledgeExample.input_exemplo });
    conversationMessages.push({ role: 'assistant', content: knowledgeExample.output_ideal });
  }
  
  conversationMessages.push({ role: 'user', content: message });

  // Log para debug
  console.log('[DEBUG PROMPT] Enviado ao Lev:\n', levSystemPrompt);

  return {
    systemPrompt: levSystemPrompt,
    tools: resolvedTools,
    model: finalModel,
    conversationMessages,
  };
}
