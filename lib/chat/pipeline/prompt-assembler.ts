// lib/chat/pipeline/prompt-assembler.ts

import { loadActiveModules } from '@/lib/modules/registry';
import { composeSystemPrompt } from '@/lib/chat/prompt-engine';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { fetchLearnedInsights } from '../pipeline/fetch-learned-insights';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';

// --- INTERFACES EXPORTADAS ---
export interface ChatPrompt {
  systemPrompt: string;
  tools: any[];
  model: string;
  conversationMessages: any[];
}

// --- CONSTANTES E AUXILIARES ---
const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /fil[ho]a/i, /esposa|marido/i,
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

function filterL3ByAffect(l3: string, recentHistoryText: string, message: string): string {
  const isHighAlertMonth = [4, 7].includes(new Date().getMonth());
  const hasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(recentHistoryText + message));
  if (isHighAlertMonth || hasFamilySignal) return l3;
  return l3
    .replace(/##\s*(datas?|aniversário|famil[íi]a|cônjuge|esposa|filho)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
    .trim();
}

// --- FUNÇÃO PRINCIPAL ---
export async function buildChatPrompt(
  ctx: ChatRequestContext,
  intel: ChatIntelligence
): Promise<ChatPrompt> {
  const { user, resolvedLocation, normalizedLocation, message } = ctx;
  const { contexts, emotional, memory, masterContext, recentHistory, isStressed } = intel;

  // 1. Módulos ativos + modelo resolvido
  const { contextBlocks, activeTools, resolvedModel } = await loadActiveModules(
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
    DEFAULT_MODEL
  );

  const finalModel = typeof resolvedModel === 'string' && resolvedModel.length > 0
    ? resolvedModel
    : DEFAULT_MODEL;

  // 2. Contexto dinâmico
  const { contextText, activeTools: dynamicTools } = await buildDynamicContext({
    userId: String(user.id),
    authUserId: user.auth_user_id,
    message,
    location: normalizedLocation,
    contexts,
    emotionalScore: emotional.score,
    masterContext,
  });

  // 3. Radar de proximidade
  let alertaRadar = '';
  if (resolvedLocation?.lat && resolvedLocation?.lng) {
    const radar = await verificarProximidade(
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

  // 6. Urgentes e Insights
  const urgentes = (masterContext?.reminders || [])
    .map((u: any) => u.title)
    .join(', ');

  const learnedInsightsBlock = await fetchLearnedInsights(String(user.id));

  // 7. System prompt final com Hierarquia de Verdade
  const systemPrompt = [
    `[RELÓGIO DO SISTEMA]: ${dataHoraSP}`,
    geoBlock,
    gpsInstruction,
    alertaRadar,

    "\n[⚠️ HIERARQUIA DE VERDADE E CONTEXTO]",
    "1. O 'AGORA' É SOBERANO: O que o usuário disse nas últimas mensagens deste chat anula qualquer informação do histórico de longo prazo (HD/L3).",
    "2. SEPARAÇÃO DE ENTIDADES: Se o usuário mencionou um nome nesta sessão (ex: Davi), mantenha o foco nele. Não confunda com nomes do HD (ex: Miguel) sem pedido explícito.",
    "3. AMBIGUIDADE DE 'MENSAGENS': O termo 'verificar mensagens' refere-se EXCLUSIVAMENTE ao histórico desta conversa atual. Nunca use ferramentas de busca externa para responder sobre o fluxo do chat.",
    "----------------------------",

    contextText,
    urgentes ? `\n[URGENTE]:  Pendências: ${urgentes}` : '',
    learnedInsightsBlock
      ? `\n[O QUE APRENDI SOBRE VOCÊ]\n${learnedInsightsBlock}`
      : '',
    '---',
    composeSystemPrompt({
      assistantName: user.assistant_name,
      authorName: user.nickname,
      isLikelyNoise: message.length < 15,
      isSystemStressed: isStressed,
      emotionalScore: emotional.score,
      detectedContexts: contexts,
      contextBlocks,
      memoryBlocks: {
        truncatedL3: `[ARQUIVO BIOGRÁFICO - PODE ESTAR DESATUALIZADO]\n${filteredL3.slice(0, 3000)}`,
        truncatedHd: `[MEMÓRIAS DE LONGO PRAZO - CONSULTA SECUNDÁRIA]\n${memory.hd.block.slice(0, 4000)}`,
        truncatedEvents: memory.events.block.slice(0, 2000),
        relationship: memory.relationship.block.slice(0, 2000),
        topics: masterContext?.topics || memory.topics.relatedTopicsBlock,
      },
      canonicalDateTimeBlock: dataHoraSP,
      canonicalDateISO: nowSP.toISOString().split('T')[0],
      systemWarning: '',
      intent: 'personal',
      dynamicGuidelines: (masterContext?.guidelines || [])
        .map((g: any) => `- ${g.content}`)
        .join('\n'),
    }),
    '\n[DIRETRIZES DE RIGOR TÉCNICO]',
    "1. ANTES DE RESPONDER: Valide o sujeito da frase no histórico recente.",
    "2. Em situações de urgência doméstica ou saúde, ignore distrações financeiras ou newsletters.",
    "3. AGENDA - SALVAR: Ao receber pedido de agendamento com pessoa e horário identificáveis, chame agenda_salvar_evento IMEDIATAMENTE. O título é extraído da frase (ex: 'consulta com Dr. Adriano' → título: 'Consulta Dr. Adriano'). NUNCA peça contato, confirmação ou informações extras para criar um evento.",
    "4. AGENDA - DELETAR: Quando o usuário pedir para apagar/cancelar/remover um evento, execute agenda_deletar_evento IMEDIATAMENTE. Se precisar do título, chame agenda_consultar primeiro. JAMAIS peça confirmação.",
    "5. AGENDA - CONSULTAR: Para responder sobre compromissos, SEMPRE chame agenda_consultar. NUNCA responda baseando-se apenas no histórico ou memória.",
    "6. ANTI-LOOP: Se você já fez uma pergunta de confirmação e o usuário respondeu afirmativamente ('sim', 'pode', 'isso', 'faz aí', 'está sim'), EXECUTE A AÇÃO. Repetir a mesma pergunta é proibido.",
    "7. Atue como Arquiteto do Expert Frotas/Procuro Quem Faça. Jamais responda 'Pronto'.",
    "8. Gerencie projetos com gerenciar_projeto/listar_projetos/gerenciar_topico/gerenciar_entry.",
    "9. Para compartilhar projetos, SEMPRE use gerenciar_membros_projeto.",
  ]
    .filter(Boolean)
    .join('\n');

  // 8. Ferramentas autorizadas
  const allActiveTools = new Set([
    ...activeTools,
    ...dynamicTools,
    ...ALWAYS_ENABLED_TOOLS,
  ]);

  const toolsHabilitadas = ALL_TOOLS.filter(t => t.function && allActiveTools.has(t.function.name));

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
