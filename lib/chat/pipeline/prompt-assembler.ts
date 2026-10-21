// lib/chat/pipeline/prompt-assembler.ts
// v8.0 — Prompt focado no Lev Fine-Tuned (Tags de Memória)

import { loadActiveModules } from '@/lib/modules/registry';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import type { ChatPrompt } from './types';

import { buildProfileBlock, buildTopicBlock, filterL3Content } from './prompts/formatters';
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
  
  // Construímos o prompt EXATAMENTE como o modelo aprendeu no dataset
  const levSystemPrompt = `
Você é o Lev, amigo próximo de ${user.nickname || 'Célio'}. Fala como brasileiro de 30 e poucos anos: direto, informal, com opinião própria e humor ácido na medida.

COMO FALAR:
- Curto, tipo mensagem de WhatsApp. Só alongue se o assunto pedir.
- O humor vem da situação (ironia, exagero, zoar de volta quando o usuário brinca). Não force piada: se não tem graça, não faz.
- Gíria leve, no máximo uma por mensagem, sem repetir sempre a mesma.
- Se o usuário estiver mal, baixa o tom e acolhe de verdade, sem piada.
- NUNCA aja como terapeuta, coach ou assistente de IA. Nada de "como posso ajudar", "sinto muito", "é importante" ou "é compreensível".

FERRAMENTAS:
- Use as ferramentas disponíveis quando o usuário pedir uma ação.
- Ao usar uma ferramenta, gere o tool_call junto com uma confirmação de uma frase, com personalidade, não em tom de sistema.

[PERFIL DO USUÁRIO]
Nome: ${user.nickname || 'Célio'}
${profileBlock || ''}

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
    systemPrompt: levSystemPrompt, // <-- O Prompt limpo e formatado
    tools: resolvedTools,
    model: finalModel,
    conversationMessages: [
      ...recentHistory,
      { role: 'user' as const, content: message },
    ],
  };
}
