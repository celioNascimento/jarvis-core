    // lib/chat/pipeline/prompt-assembler.ts
// V11.3.0 — Proteção de Core Tools Permanente (Inclusão de Esportes e Web Search)

import { loadActiveModules } from '@/lib/modules/registry';
import { composeSystemPrompt } from '@/lib/chat/prompt-engine';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { fetchLearnedInsights } from '../pipeline/fetch-learned-insights';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';

export interface ChatPrompt {
  systemPrompt: string;
  tools: any[];
  model: string;
  conversationMessages: any[];
}

const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /fil[ho]a/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';

// ✅ CORE TOOLS BLINDADO: Impede a perda das ferramentas mesmo em respostas curtas (ex: "sim")
const ALWAYS_ENABLED_TOOLS = new Set([
  // Projetos
  'projeto_gerenciar',
  'projeto_listar',
  'projeto_gerenciar_topico',
  'projeto_listar_topicos',
  'projeto_gerenciar_entry',
  'projeto_listar_entries',
  'projeto_gerenciar_membros',
  
  // Agenda & Lembretes
  'agenda_consultar',
  'agenda_salvar_evento',
  'agenda_deletar_evento',
  'lembrete_criar',
  'lembrete_consultar',
  'lembrete_cancelar',
  'contato_alternar_permissao',

  // Rotinas
  'listar_rotinas',
  'gerenciar_rotina',
  'fazer_checkin_rotina',

  // Clima
  'clima_consultar_atual',

  // Esportes (Proteção do novo ecossistema)
  'esportes_consultar_placar_ao_vivo',
  'esportes_consultar_tabela',

  // Busca Global de Internet (Plano B caso precise pesquisar ligas de fora / outros esportes)
  'web_pesquisar'
]);

function filterL3ByAffect(l3: string, recentHistoryText: string, message: string): string {
  const isHighAlertMonth = [4, 7].includes(new Date().getMonth());
  const hasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(recentHistoryText + message));
  if (isHighAlertMonth || hasFamilySignal) return l3;
  return l3
    .replace(/##\s*(datas?|aniversário|famil[íi]a|cônjuge|esposa|filho)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
    .trim();
}

export async function buildChatPrompt(
  ctx: ChatRequestContext,
  intel: ChatIntelligence
): Promise<ChatPrompt> {
  const { user, resolvedLocation, normalizedLocation, message } = ctx;
  const { contexts, emotional, memory, masterContext, recentHistory, isStressed } = intel;

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

  const { contextText, activeTools: dynamicTools } = await buildDynamicContext({
    userId: String(user.id),
    authUserId: user.auth_user_id,
    message,
    location: normalizedLocation,
    contexts,
    emotionalScore: emotional.score,
    masterContext,
  });

  let alertaRadar = '';
  if (resolvedLocation?.lat && resolvedLocation?.lng) {
    const radar = await verificarProximidade(
      String(user.id),
      Number(resolvedLocation.lat),
      Number(resolvedLocation.lng)
    );
    if (radar.temAlerta) alertaRadar = `\n[ALERTA RADAR]: ${radar.mensagem}`;
  }

  const nowSP = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
  );
  const dataHoraSP = nowSP.toLocaleString('pt-BR');
  const geoBlock = buildGeoBlock(resolvedLocation);

  const gpsInstruction = resolvedLocation
    ? `\n[DIRETRIZ CRÍTICA]: O usuário está REALMENTE em: ${resolvedLocation.label || 'Londrina'}. Ignore qualquer endereço divergente do histórico.`
    : `\n[STATUS GPS]: INDISPONÍVEL. Proibido adivinhar localização baseando-se no histórico.`;

  const historyText = recentHistory.map(h => h.content).join(' ');
  const filteredL3 = filterL3ByAffect(memory.l3.content, historyText, message);

  const urgentes = (masterContext?.reminders || [])
    .map((u: any) => u.title)
    .join(', ');

  const learnedInsightsBlock = await fetchLearnedInsights(String(user.id));

  const systemPrompt = [
    `[RELÓGIO DO SISTEMA]: ${dataHoraSP}`,
    geoBlock,
    gpsInstruction,
    alertaRadar,

    "\n[⚠️ HIERARQUIA DE VERDADE E CONTEXTO]",
    "1. O 'AGORA' É SOBERANO: O que o usuário disse nas últimas mensagens deste chat anula qualquer informação do histórico de longo prazo (HD/L3).",
    "2. SEPARAÇÃO DE ENTIDADES: Se o usuário mencionou um nome nesta sessão (ex: Davi), mantenha o foco nele. Não confunda com nomes do HD (ex: Miguel) sem pedido explicitamente.",
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
    "3. AGENDA - SALVAR: Ao receber pedido de agendamento com pessoa e horário identificáveis, chame agenda_salvar_evento IMEDIATAMENTE. O título é extraído da frase. NUNCA peça contato, confirmação ou informações extras.",
    "4. AGENDA - DELETAR: Quando o usuário pedir para apagar/cancelar/remover um evento, execute agenda_deletar_evento IMEDIATAMENTE. JAMAIS peça confirmação.",
    "5. AGENDA - CONSULTAR: Para responder sobre compromissos, SEMPRE chame agenda_consultar. NUNCA responda baseando-se apenas no histórico ou memória.",
    "6. ANTI-LOOP: Se você já fez uma pergunta de confirmação e o usuário respondeu afirmativamente ('sim', 'pode', 'isso'), EXECUTE A AÇÃO. Repetir a mesma pergunta é proibido.",
    "7. Atue como Arquiteto do Expert Frotas/Procuro Quem Faça. Jamais responda 'Pronto'.",
    "8. Gerencie projetos com projeto_gerenciar/projeto_listar/projeto_gerenciar_topico/projeto_gerenciar_entry.",
    "9. Para compartilhar projetos, SEMPRE use projeto_gerenciar_membros.",
    "10. LEMBRETES - CRIAR: Ao receber pedido de lembrete com título e horário identificáveis, chame lembrete_criar IMEDIATAMENTE. NUNCA peça confirmação.",
    "11. LEMBRETES - CANCELAR: Para cancelar, chame lembrete_cancelar diretamente. Se precisar do título, chame lembrete_consultar primeiro.",
    "12. LEMBRETES - CONSULTAR: Para responder sobre lembretes ativos, SEMPRE chame lembrete_consultar.",
    "13. ROTINAS & HÁBITOS: Use listar_rotinas para ver o progresso, gerenciar_rotina para alterar e fazer_checkin_rotina para computar os hábitos do dia.",
    "14. CLIMA: Sempre que o usuário perguntar sobre o tempo ou demonstrar dúvida sobre sair de casa, consulte o clima atual com clima_consultar_atual.",
    "15. ESPORTES: Sempre que houver perguntas sobre o resultado, tabela, classificação ou placar de futebol de hoje das ligas brasileiras ou europeias, chame esportes_consultar_placar_ao_vivo ou esportes_consultar_tabela.",
    "16. INTERNET: Se a pergunta de esporte envolver ligas não mapeadas (ex: NBA, NFL) ou se as ferramentas de futebol retornarem vazio, use web_pesquisar imediatamente para obter a resposta em tempo real."
  ]
    .filter(Boolean)
    .join('\n');

  const allActiveTools = new Set([
    ...activeTools,
    ...dynamicTools,
    ...ALWAYS_ENABLED_TOOLS,
  ]);

  const toolsHabilitadas = ALL_TOOLS.filter(t => t.function && allActiveTools.has(t.function.name));

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
