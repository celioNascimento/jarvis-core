// lib/chat/pipeline/prompt-assembler.ts
// v9.0 — O Híbrido Perfeito: Contexto rico original + Formato de treino do Lev

import { loadActiveModules } from '@/lib/modules/registry';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import type { ChatPrompt } from './types';

import { 
  buildFamilyBlock, 
  buildProfileBlock, 
  buildTopicBlock, 
  buildUrgentesString, 
  buildGuidelinesString,
  filterL3Content 
} from './prompts/formatters';

import { inferEmotionalStateFromHistory } from './utils/infer-emotional-state';
import { buildFewShotExamplesPrompt } from './prompts/few-shot-examples';
import { buildPersonalityBlock } from '@/lib/services/personality.service';
import { buildLearnedInsightsBlock, buildPersonalityFromContext } from '@/lib/Utils/ai-helpers';

const DEFAULT_MODEL = process.env.HF_MODEL_ID || 'celioNascimento/Lev-LoRA-Orquestrador';
const ALWAYS_ON_TOOLS = ['web_pesquisar'] as const;

export async function buildChatPrompt(
  ctx: ChatRequestContext,
  intel: ChatIntelligence,
): Promise<ChatPrompt> {
  const { user, resolvedLocation, normalizedLocation, message } = ctx;
  const { contexts, emotional, masterContext, recentHistory } = intel;

  // ── 1. RESGATANDO OS BLOCOS PERDIDOS ──────────────────────────────────────
  const profileBlock = buildProfileBlock(masterContext?.profile);
  const topicsBlock = buildTopicBlock(masterContext);
  const familyBlock = buildFamilyBlock(masterContext?.persons || [], masterContext?.children || []);
  const urgentes = buildUrgentesString(masterContext);
  const guidelines = buildGuidelinesString(masterContext);
  const learnedInsightsBlock = buildLearnedInsightsBlock(masterContext?.insights || []);
  const personalitySettings = buildPersonalityFromContext(masterContext?.settings);
  const personalityBlock = buildPersonalityBlock(personalitySettings);

  // ── 2. DATA E LOCALIZAÇÃO ─────────────────────────────────────────────────
  const nowSP = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dataHoraSP = nowSP.toLocaleString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const geoBlock = buildGeoBlock(resolvedLocation);
  
  let alertaRadar: string | null = null;
  if (masterContext?.radar_alert) {
    alertaRadar = `[ALERTA RADAR]: ${masterContext.radar_alert}`;
  }

  // ── 3. CARGAS PARALELAS ───────────────────────────────────────────────────
  const [moduleResult, dynamicResult, fewShotBlock] = await Promise.all([
    loadActiveModules(
      { userId: String(user.id), authUserId: user.auth_user_id, message, contexts, emotionalScore: emotional.score, location: normalizedLocation, masterContext },
      user.plan, DEFAULT_MODEL,
    ),
    buildDynamicContext({ userId: String(user.id), authUserId: user.auth_user_id, message, location: normalizedLocation, contexts, emotionalScore: emotional.score, masterContext }),
    buildFewShotExamplesPrompt(message, intel.queryEmbedding),
  ]);

  const finalModel = moduleResult.resolvedModel || DEFAULT_MODEL;

  // ── 4. L3 / Dossiê ────────────────────────────────────────────────────────
  const rawL3Text = masterContext?.dossier_summary || masterContext?.user?.current_context || '';
  const l3Filtered = filterL3Content(rawL3Text, false);
  const l3Content = l3Filtered.length > 4000 ? l3Filtered.slice(0, 4000) + '...' : l3Filtered;

  // ── 5. MONTAGEM FINAL (Híbrido) ───────────────────────────────────────────
  const levSystemPrompt = `
Você é Lev, um amigo inteligente, com opinião própria e senso de humor natural. 
NUNCA aja como um terapeuta, coach ou assistente de IA genérica.
NUNCA diga "como posso ajudar", "sinto muito" ou "não tenho acesso a registros".
Você TEM acesso a todas as informações abaixo. Use-as.

[CONTEXTO TEMPORAL E GEOGRÁFICO]
Data/Hora: ${dataHoraSP}
Localização: ${geoBlock || 'Não informada'}
${alertaRadar ? `Atenção: ${alertaRadar}` : ''}

[PERSONALIDADE CONFIGURADA]
${personalityBlock || 'Tom padrão: amigável e descontraído.'}

[PERFIL DO USUÁRIO]
Nome: ${user.nickname || 'Célio'}
${profileBlock || ''}

[FAMÍLIA]
${familyBlock || 'Nenhum familiar registrado.'}

[DIRETRIZES DINÂMICAS]
${guidelines || 'Nenhuma diretriz específica.'}

[LEMBRETES URGENTES]
${urgentes || 'Nenhum lembrete urgente agora.'}

[MEMÓRIAS RECUPERADAS E INSIGHTS]
${l3Content}
${learnedInsightsBlock}

[CONTEXTO ADICIONAL E TÓPICOS]
${topicsBlock}
${fewShotBlock}
  `.trim();

  // ── 6. FERRAMENTAS ────────────────────────────────────────────────────────
  const allToolKeys = new Set<string>([
    ...ALWAYS_ON_TOOLS,
    ...(moduleResult.activeTools || []),
    ...(dynamicResult.activeTools || []),
  ]);

  const resolvedTools = ALL_TOOLS.filter(
    (t: any) => t.function?.name && allToolKeys.has(t.function.name),
  );

  // LOG DE DEBUG: Para ver o prompt final no painel da Vercel
  console.log('[DEBUG PROMPT] Enviado ao Lev:\n', levSystemPrompt);

  return {
    systemPrompt: levSystemPrompt, 
    tools: resolvedTools,
    model: finalModel,
    conversationMessages: [
      ...recentHistory,
      { role: 'user' as const, content: message },
    ],
  };
}
