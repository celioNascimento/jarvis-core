// lib/chat/pipeline/prompt-assembler.ts
// v12.0 — O Resgate Definitivo: Contexto Original + Formato LoRA (Memórias no Topo)

import { loadActiveModules } from '@/lib/modules/registry';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import type { ChatPrompt } from './types';

// Blocos de prompt originais resgatados
import { buildIdentityPrompt } from './prompts/identity';
import { buildActiveContextPrompt } from './prompts/active-context';
import { buildMemoryPrompt } from './prompts/memory';
import { buildMemoryHonestyPrompt } from './prompts/memory-honesty';
import { buildEmotionalProtocolPrompt } from './prompts/emotional-protocol';
import { buildMoralMirrorPrompt, EmotionalState } from './prompts/moral-mirror';
import { buildIntellectualFrictionPrompt } from './prompts/intellectual-friction';
import { buildOperationalPrompt } from './prompts/operational';
import { buildFewShotExamplesPrompt } from './prompts/few-shot-examples';

// Formatadores originais resgatados
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

const DEFAULT_MODEL = process.env.HF_MODEL_ID || 'celioNascimento/Lev-LoRA-Orquestrador-Merged';
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

  // ── 1. MONTAGEM DOS DADOS ──────────────────────────────────────────────────
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

  // ── 2. TEMPO E LOCALIZAÇÃO ────────────────────────────────────────────────
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

  // ── 3. HISTÓRICO, L3 E ESTADOS ────────────────────────────────────────────
  const historyText = recentHistory.map(h => h.content).join(' ');
  const includeFamily = shouldIncludeFamilyContext(message, historyText);
  const rawL3Text = masterContext?.dossier_summary || masterContext?.user?.current_context || '';
  const l3Content = filterL3Content(rawL3Text, includeFamily).slice(0, 3000); // Limite seguro
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

  // ── 5. FERRAMENTAS ────────────────────────────────────────────────────────
  const allToolKeys = new Set<string>([...ALWAYS_ON_TOOLS, ...(moduleResult.activeTools || []), ...(dynamicResult.activeTools || [])]);
  const resolvedTools = ALL_TOOLS.filter((t: any) => t.function?.name && allToolKeys.has(t.function.name));
  const toolNames = resolvedTools.map((t: any) => t.function.name).join(', ');

  // ── 6. MONTAGEM FINAL DO PROMPT ───────────────────────────────────────────
  const levSystemPrompt = `
Você é Lev, um amigo inteligente e natural. NUNCA aja como terapeuta genérico, coach ou assistente.
NUNCA diga "como posso ajudar" ou "não tenho acesso a registros". Você TEM acesso às informações abaixo.
Ferramentas disponíveis no sistema (${toolNames || 'nenhuma'}): use-as sempre que o usuário pedir uma ação.

[PERFIL DO USUÁRIO]
Nome: ${user.nickname || 'Célio'}
${profileBlock}

[FAMÍLIA]
${familyBlock || 'Nenhum familiar registrado no momento.'}

[MEMÓRIAS RECUPERADAS]
${l3Content}
${learnedInsightsBlock}

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
  learnedInsightsBlock: '',
  profileBlock: '',
  familyBlock: '',
  personalityBlock: personalityBlock,
  l3Content: '',
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

  // ── 7. MENSAGENS E KNOWLEDGE RAG ──────────────────────────────────────────
  const conversationMessages: any[] = [...recentHistory];
  
  if (knowledgeExample) {
    conversationMessages.push({ role: 'user', content: knowledgeExample.input_exemplo });
    conversationMessages.push({ role: 'assistant', content: knowledgeExample.output_ideal });
  }
  
  conversationMessages.push({ role: 'user', content: message });

  // Log de debug (pode apagar em produção se quiser)
  console.log('[DEBUG PROMPT] Enviado ao Lev:\n', levSystemPrompt);

  return {
    systemPrompt: levSystemPrompt,
    tools: resolvedTools,
    model: finalModel,
    conversationMessages,
  };
}
