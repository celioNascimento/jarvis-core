// lib/chat/pipeline/prompt-assembler.ts
// v8.1 — Injetando bloco familiar e banindo comportamento de IA genérica

import { loadActiveModules } from '@/lib/modules/registry';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import type { ChatPrompt } from './types';

// Importamos as funções que montam o perfil e a família
import { buildProfileBlock, buildTopicBlock, filterL3Content, buildFamilyBlock } from './prompts/formatters';
import { inferEmotionalStateFromHistory } from './utils/infer-emotional-state';
import { buildFewShotExamplesPrompt } from './prompts/few-shot-examples';

const DEFAULT_MODEL = process.env.HF_MODEL_ID || 'celioNascimento/Lev-LoRA-Orquestrador';
const ALWAYS_ON_TOOLS = ['web_pesquisar'] as const;

export async function buildChatPrompt(
  ctx: ChatRequestContext,
  intel: ChatIntelligence,
): Promise<ChatPrompt> {
  const { user, resolvedLocation, normalizedLocation, message } = ctx;
  const { contexts, emotional, masterContext, recentHistory } = intel;

  // ── Formatação de dados do masterContext ───────────────────
  const profileBlock = buildProfileBlock(masterContext?.profile);
  const topicsBlock = buildTopicBlock(masterContext);
  
  // AQUI ESTÁ A CORREÇÃO: Resgatando os dados da família (esposa, filhos)
  const familyBlock = buildFamilyBlock(
    masterContext?.persons || [],
    masterContext?.children || [],
  );
  
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

  // ── L3 / Dossiê ───────────────────────────────────────────────────────────
  const historyText = recentHistory.map(h => h.content).join(' ');
  const rawL3Text = masterContext?.dossier_summary || masterContext?.user?.current_context || '';
  const l3Filtered = filterL3Content(rawL3Text, false);
  const l3Content = l3Filtered.length > 4000
    ? l3Filtered.slice(0, 4000) + '... (resumo completo em memória HD)'
    : l3Filtered;

  // ── MONTAGEM DO SYSTEM PROMPT (Formato de Treino) ─────────────────────────
  
  const levSystemPrompt = `
Você é Lev, um amigo inteligente, com opinião própria. 
NUNCA aja como um terapeuta, coach ou assistente de IA genérica.
NUNCA diga "como posso ajudar", "é importante", "sinto muito", "é difícil lidar" ou "não tenho acesso a registros pessoais". Você TEM acesso às memórias abaixo.

[PERFIL DO USUÁRIO]
Nome: ${user.nickname || 'Célio'}
${profileBlock || ''}

[FAMÍLIA]
${familyBlock || 'Nenhum familiar registrado.'}

[MEMÓRIAS RECUPERADAS]
${l3Content}
${(masterContext?.insights || []).map((i: any) => `- ${i.content}`).join('\n')}

[CONTEXTO ADICIONAL]
${topicsBlock || ''}
${fewShotBlock || ''}
  `.trim();

  // ── Ferramentas ───────────────────────────────────────────────────────────
  const allToolKeys = new Set<string>([
    ...ALWAYS_ON_TOOLS,
    ...(moduleResult.activeTools || []),
    ...(dynamicResult.activeTools || []),
  ]);

  const resolvedTools = ALL_TOOLS.filter(
    (t: any) => t.function?.name && allToolKeys.has(t.function.name),
  );

  // Retorno final adaptado
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
