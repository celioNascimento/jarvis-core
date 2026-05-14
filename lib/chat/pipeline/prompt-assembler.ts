// lib/chat/pipeline/prompt-assembler.ts
// V12 — Injeção de Dependência Total (Zero Latência de Rede)

import { loadActiveModules } from '@/lib/modules/registry';
import { composeSystemPrompt } from '@/lib/chat/prompt-engine';
import { buildGeoBlock } from '@/lib/geo-resolver';
import { verificarAlertasDeProximidade } from '@/lib/geo';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { fetchLearnedInsights } from '../pipeline/fetch-learned-insights';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';

const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /filh[oa]/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';

const ALWAYS_ENABLED_TOOLS = new Set([
  'gerenciar_projeto',
  'listar_projetos',
  'gerenciar_topico',
  'listar_topicos',
  'gerenciar_entry',
  'listar_entries',
  'gerenciar_membros_projeto',
]);

export interface ChatPrompt {
  systemPrompt: string;
  tools: any[];
  model: string;
  conversationMessages: any[];
}

function filterL3ByAffect(l3: string, recentHistoryText: string, message: string): string {
  const isHighAlertMonth = [4, 7].includes(new Date().getMonth());
  const hasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(recentHistoryText + message));
  if (isHighAlertMonth || hasFamilySignal) return l3;
  return l3.replace(/##\s*(datas?|aniversário|famil[íi]a|cônjuge|esposa|filho)[^\n]*\n[\s\S]*?(?=##|$)/gi, '').trim();
}

export async function buildChatPrompt(
  ctx: ChatRequestContext,
  intel: ChatIntelligence
): Promise<ChatPrompt> {
  const { user, resolvedLocation, normalizedLocation, message } = ctx;
  const { contexts, emotional, memory, masterContext, recentHistory, isStressed } = intel;

  // 1. Módulos ativos (MasterContext Injetado aqui)
  const { contextBlocks, activeTools, resolvedModel } = await loadActiveModules(
    {
      userId:         user.id, // ✅ Passando como number direto
      authUserId:     user.auth_user_id,
      message,
      contexts,
      emotionalScore: emotional.score,
      location:       normalizedLocation,
      masterContext, // ✅ Garantindo o repasse do contexto
    },
    user.plan,
    DEFAULT_MODEL
  );

  const finalModel = resolvedModel || DEFAULT_MODEL;

  // 2. Contexto dinâmico (MasterContext Injetado aqui)
  const { contextText, activeTools: dynamicTools } = await buildDynamicContext({
    userId:         user.id,
    authUserId:     user.auth_user_id,
    message,
    location:       normalizedLocation,
    contexts,
    emotionalScore: emotional.score,
    masterContext,
  });

  // 3. Radar de proximidade (Otimizado: Se houver locations no context, usamos elas)
  let alertaRadar = '';
  if (resolvedLocation?.lat && resolvedLocation?.lng) {
    // Só chama o radar se tivermos coordenadas
    const radar = await verificarAlertasDeProximidade(
      String(user.id),
      Number(resolvedLocation.lat),
      Number(resolvedLocation.lng)
    );
    if (radar.temAlerta) alertaRadar = `\n[ALERTA RADAR]: ${radar.mensagem}`;
  }

  // 4. Data/hora e geo
  const nowSP = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dataHoraSP = nowSP.toLocaleString('pt-BR');
  const geoBlock = buildGeoBlock(resolvedLocation);

  const gpsInstruction = resolvedLocation
    ? `\n[DIRETRIZ CRÍTICA]: O usuário está REALMENTE em: ${resolvedLocation.label || 'Londrina'}.`
    : `\n[STATUS GPS]: INDISPONÍVEL.`;

  // 5. Insights Aprendidos (Usa cache do MasterContext se disponível)
  let learnedInsightsBlock = '';
  if (masterContext?.insights) {
      learnedInsightsBlock = masterContext.insights; // ✅ Prioridade zero DB
  } else {
      learnedInsightsBlock = await fetchLearnedInsights(String(user.id));
  }

  // 6. System prompt final
  const systemPrompt = [
    `[RELÓGIO DO SISTEMA]: ${dataHoraSP}`,
    geoBlock,
    gpsInstruction,
    alertaRadar,
    contextText,
    masterContext?.reminders?.length ? `\n[URGENTE]: Pendências: ${masterContext.reminders.map((r: any) => r.title).join(', ')}` : '',
    learnedInsightsBlock ? `\n[O QUE APRENDI SOBRE VOCÊ]\n${learnedInsightsBlock}` : '',
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
        truncatedL3:     filterL3ByAffect(memory.l3.content, recentHistory.map(h => h.content).join(' '), message).slice(0, 3000),
        truncatedHd:     memory.hd.block.slice(0, 4000),
        truncatedEvents: memory.events.block.slice(0, 2000),
        relationship:    memory.relationship.block.slice(0, 2000),
        topics:          masterContext?.topics || memory.topics.relatedTopicsBlock,
      },
      canonicalDateTimeBlock: dataHoraSP,
      canonicalDateISO:       nowSP.toISOString().split('T')[0],
      systemWarning:          '',
      intent:                 'personal',
      dynamicGuidelines:      (masterContext?.guidelines || []).map((g: any) => `- ${g.content}`).join('\n'),
    }),
    '\n[DIRETRIZES DE RIGOR TÉCNICO]',
    "1. Use 'salvar_evento' como fonte primária.",
    "2. Atue como Arquiteto do Expert Frotas/Procuro Quem Faça.",
    "3. SEMPRE use gerenciar_membros_projeto para compartilhar projetos.",
  ].filter(Boolean).join('\n');

  // 8. Ferramentas
  const allActiveTools = new Set([...activeTools, ...dynamicTools, ...ALWAYS_ENABLED_TOOLS]);
  const toolsHabilitadas = ALL_TOOLS.filter(t => allActiveTools.has(t.function.name));

  return {
    systemPrompt,
    tools: toolsHabilitadas,
    model: finalModel,
    conversationMessages: [{ role: 'system', content: systemPrompt }, ...recentHistory, { role: 'user', content: message }],
  };
}
