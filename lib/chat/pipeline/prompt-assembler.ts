// lib/chat/pipeline/prompt-assembler.ts
// Fase 3 — Montagem do System Prompt, Módulos e Ferramentas
//
// Recebe ChatRequestContext + ChatIntelligence e devolve ChatPrompt:
// systemPrompt final, ferramentas autorizadas e modelo resolvido.
// É a única fase que conhece composeSystemPrompt, buildGeoBlock,
// loadActiveModules e buildDynamicContext.

import { loadActiveModules } from '@/lib/modules/registry';
import { composeSystemPrompt } from '@/lib/chat/prompt-engine';
import { buildGeoBlock } from '@/lib/geo-resolver';
import { verificarAlertasDeProximidade } from '@/lib/geo';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { fetchLearnedInsights } from '../pipeline/fetch-learned-insights';

// Importação das ferramentas do local correto:
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';

// Importação dos Tipos:
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';

const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /filh[oa]/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';

// ─── Tools sempre disponíveis (independente de módulos) ───────────────────────
// Adicione aqui qualquer tool que deve estar acessível em toda conversa.
// NUNCA remova uma tool daqui sem verificar se ela está coberta pelo registry.

const ALWAYS_ENABLED_TOOLS = new Set([
  // Projetos
  'gerenciar_projeto',
  'listar_projetos',
  'gerenciar_topico',
  'listar_topicos',
  'gerenciar_entry',
  'listar_entries',
  'gerenciar_membros_projeto',   // ← compartilhamento de projetos
]);

// ─── Tipos exportados ─────────────────────────────────────────────────────────

export interface ChatPrompt {
  systemPrompt: string;
  tools: any[];
  model: string;
  conversationMessages: any[];
}

// ─── Filtro de L3 por data/família ───────────────────────────────────────────

function filterL3ByAffect(
  l3: string,
  recentHistoryText: string,
  message: string
): string {
  const isHighAlertMonth = [4, 7].includes(new Date().getMonth());
  const hasFamilySignal = FAMILY_DATE_SIGNALS.some(
    p => p.test(recentHistoryText + message)
  );

  if (isHighAlertMonth || hasFamilySignal) return l3;

  return l3
    .replace(/##\s*(datas?|aniversário|famil[íi]a|cônjuge|esposa|filho)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
    .trim();
}

// ─── Entrypoint público ───────────────────────────────────────────────────────

export async function buildChatPrompt(
  ctx: ChatRequestContext,
  intel: ChatIntelligence
): Promise<ChatPrompt> {
  const { user, resolvedLocation, normalizedLocation, message, requestSignature } = ctx;
  const { contexts, emotional, memory, masterContext, recentHistory, isStressed } = intel;

  // 1. Módulos ativos + modelo resolvido
  const { contextBlocks, activeTools, resolvedModel } = await loadActiveModules(
    {
      userId:         String(user.id),
      authUserId:     user.auth_user_id,
      message,
      contexts,
      emotionalScore: emotional.score,
      location:       normalizedLocation,
      masterContext,
    },
    user.plan,
    DEFAULT_MODEL
  );

  const finalModel = typeof resolvedModel === 'string' && resolvedModel.length > 0
    ? resolvedModel
    : DEFAULT_MODEL;

  // 2. Contexto dinâmico (módulos complementares)
  const { contextText, activeTools: dynamicTools } = await buildDynamicContext({
    userId:         String(user.id),
    authUserId:     user.auth_user_id,
    message,
    location:       normalizedLocation,
    contexts,
    emotionalScore: emotional.score,
    masterContext,
  });

  // 3. Radar de proximidade
  let alertaRadar = '';
  if (resolvedLocation?.lat && resolvedLocation?.lng) {
    const radar = await verificarAlertasDeProximidade(
      String(user.id),
      Number(resolvedLocation.lat),
      Number(resolvedLocation.lng)
    );
    if (radar.temAlerta) alertaRadar = `\n[ALERTA RADAR]: ${radar.mensagem}`;
  }

  // 4. Data/hora e geo
  const nowSP = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
  );
  const dataHoraSP = nowSP.toLocaleString('pt-BR');
  const geoBlock = buildGeoBlock(resolvedLocation);

  const gpsInstruction = resolvedLocation
    ? `\n[DIRETRIZ CRÍTICA]: O usuário está REALMENTE em: ${resolvedLocation.label || 'Londrina'}. Ignore qualquer endereço divergente do histórico.`
    : `\n[STATUS GPS]: INDISPONÍVEL. Proibido adivinhar localização baseando-se no histórico.`;

  // 5. Filtro de afeto no L3
  const historyText = recentHistory.map(h => h.content).join(' ');
  const filteredL3 = filterL3ByAffect(memory.l3.content, historyText, message);

  // 6. Urgentes
  const urgentes = (masterContext?.reminders || [])
    .map((u: any) => u.title)
    .join(', ');

  // 6b. Shadow Prompting — insights aprendidos pelo Jarvis
  const learnedInsightsBlock = await fetchLearnedInsights(String(user.id));

  // 7. System prompt final
  const systemPrompt = [
    `[RELÓGIO DO SISTEMA]: ${dataHoraSP}`,
    geoBlock,
    gpsInstruction,
    alertaRadar,
    contextText,
    urgentes ? `\n[URGENTE]: Pendências: ${urgentes}` : '',
    learnedInsightsBlock
      ? `\n[O QUE APRENDI SOBRE VOCÊ]\n${learnedInsightsBlock}`
      : '',
    '---',
    composeSystemPrompt({
      assistantName:    user.assistant_name,
      authorName:       user.nickname,
      isLikelyNoise:    message.length < 15,
      isSystemStressed: isStressed,
      emotionalScore:   emotional.score,
      detectedContexts: contexts,
      contextBlocks,
      memoryBlocks: {
        truncatedL3:     filteredL3.slice(0, 3000),
        truncatedHd:     memory.hd.block.slice(0, 4000),
        truncatedEvents: memory.events.block.slice(0, 2000),
        relationship:    memory.relationship.block.slice(0, 2000),
        topics:          masterContext?.topics || memory.topics.relatedTopicsBlock,
      },
      canonicalDateTimeBlock: dataHoraSP,
      canonicalDateISO:       nowSP.toISOString().split('T')[0],
      systemWarning:          '',
      intent:                 'personal',
      dynamicGuidelines:      (masterContext?.guidelines || [])
        .map((g: any) => `- ${g.content}`)
        .join('\n'),
    }),
    '\n[DIRETRIZES DE RIGOR TÉCNICO]',
    "1. Use 'salvar_evento' como fonte primária.",
    "2. Atue como Arquiteto do Expert Frotas/Procuro Quem Faça. Jamais responda 'Pronto'.",
    "3. Gerencie projetos com gerenciar_projeto/listar_projetos/gerenciar_topico/gerenciar_entry.",
    "4. Para compartilhar projetos, SEMPRE use gerenciar_membros_projeto — nunca diga que não é possível.",
  ]
    .filter(Boolean)
    .join('\n');

  // 8. Ferramentas autorizadas
  // União de: módulos do registry + dinâmicas + ALWAYS_ENABLED_TOOLS
  const allActiveTools = new Set([
    ...activeTools,
    ...dynamicTools,
    ...ALWAYS_ENABLED_TOOLS,
  ]);

  const toolsHabilitadas = ALL_TOOLS.filter(t =>
    allActiveTools.has(t.function.name)
  );

  // 9. Mensagens para o LLM
  const conversationMessages = [
    { role: 'system', content: systemPrompt },
    ...recentHistory,
    { role: 'user', content: message },
  ];

  return {
    systemPrompt,
    tools: toolsHabilitadas,
    model: finalModel,
    conversationMessages,
  };
}
