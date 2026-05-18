// lib/chat/pipeline/prompt-assembler.ts
// V11.4.1 — Protocolo de Sinergia Inter-Módulos + Anti-Dispersão e Execução em Lote

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

const ALWAYS_ENABLED_TOOLS = new Set([
  'projeto_gerenciar',
  'projeto_listar',
  'projeto_gerenciar_topico',
  'projeto_listar_topicos',
  'projeto_gerenciar_entry',
  'projeto_listar_entries',
  'projeto_gerenciar_membros',
  'agenda_consultar',
  'agenda_salvar_evento',
  'agenda_deletar_evento',
  'lembrete_criar',
  'lembrete_consultar',
  'lembrete_cancelar',
  'contato_alternar_permissao',
  'listar_rotinas',
  'gerenciar_rotina',
  'fazer_checkin_rotina',
  'clima_consultar_atual',
  'esportes_consultar_placar_ao_vivo',
  'esportes_consultar_tabela',
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

  // 🟢 ARRAY UNIFICADO E CORRIGIDO
  const systemPrompt = [
    `[RELÓGIO DO SISTEMA]: ${dataHoraSP}`,
    geoBlock,
    gpsInstruction,
    alertaRadar,

    "\n[⚠️ HIERARQUIA DE VERDADE E CONTEXTO]",
    "1. O 'AGORA' É SOBERANO: O que o usuário disse nas últimas mensagens deste chat anula qualquer informação do histórico de longo prazo (HD/L3).",
    "2. SEPARAÇÃO DE ENTIDADES: Se o usuário mencionou um nome nesta sessão (ex: Davi), mantenha o foco nele. Não confunda com nomes do HD (ex: Miguel) sem pedido explícito.",
    "3. AMBIGUIDADE DE 'MENSAGENS': O termo 'verificar mensagens' refere-se EXCLUSIVAMENTE ao histórico desta conversa atual.",
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

    "\n[⚡ PROTOCOLO DE SINERGIA INTER-MÓDULOS]",
    "Você tem permissão e o dever de COMBINAR e ENCADEAR ferramentas de módulos diferentes sequencialmente ou em paralelo para dar a melhor resposta técnica. Exemplos de receitas recomendadas:",
    "- [PROJETOS + FOCO]: Ao criar ou listar uma tarefa complexa no módulo de projetos, chame 'tdah_quebrar_tarefa' em seguida para fatiá-la.",
    "- [CLIMA + ROTINAS]: Ao listar rotinas matinais, execute em paralelo 'clima_consultar_atual' para enriquecer a resposta com alertas de chuva/frio.",
    "- [ESPORTES + INTERNET]: Ao consultar placares e o retorno vier vazio, acione 'web_pesquisar' para buscar os dados em tempo real no Google.",
    "- [FINANÇAS + COMPRAS]: Ao adicionar um item de alto valor em uma lista, consulte o saldo para emitir feedback preventivo.",

    '\n[DIRETRIZES DE RIGOR TÉCNICO E FOCO ABSOLUTO]',
    "1. ANTES DE RESPONDER: Valide o sujeito da frase no histórico recente.",
    "2. Em situações de urgência doméstica ou saúde, ignore distrações financeiras ou newsletters.",
    "3. EXECUÇÃO EM LOTE (BATCH): Se você sugerir múltiplas ações (ex: Lembrete, Agenda, Rotina) e o usuário responder 'todas', 'faça tudo' ou confirmar no plural, EXECUTE TODAS as ferramentas simultaneamente. Não mude de assunto.",
    "4. ANTI-DISPERSÃO: É ESTRITAMENTE PROIBIDO oferecer sugestões não solicitadas de lazer ou amenidades (ex: checar o clima, jogos, usabilidade) enquanto um fluxo de tarefas estiver aberto. Cumpra a ordem e seja cirúrgico.",
    "5. OBEDIÊNCIA A CORREÇÕES: Se o usuário disser 'não perca o foco' ou corrigir um desvio seu, aborte o assunto paralelo imediatamente e retome a tarefa original. Não tente justificar o erro.",
    "6. AGENDA - SALVAR: Ao receber pedido de agendamento com pessoa e horário identificáveis, chame agenda_salvar_evento IMEDIATAMENTE.",
    "7. AGENDA - DELETAR: Quando o usuário pedir para apagar/cancelar/remover um evento, execute agenda_deletar_evento IMEDIATAMENTE.",
    "8. AGENDA - CONSULTAR: Para responder sobre compromissos, SEMPRE chame agenda_consultar.",
    "9. ANTI-LOOP: Se você já fez uma pergunta de confirmação e o usuário respondeu afirmativamente, EXECUTE A AÇÃO.",
    "10. Atue como Arquiteto do Expert Frotas/Procuro Quem Faça. Jamais responda 'Pronto'.",
    "11. Gerencie projetos com projeto_gerenciar/projeto_listar/projeto_gerenciar_topico/projeto_gerenciar_entry.",
    "12. Para compartilhar projetos, SEMPRE use projeto_gerenciar_membros.",
    "13. LEMBRETES - CRIAR: Ao receber pedido de lembrete chame lembrete_criar IMEDIATAMENTE.",
    "14. LEMBRETES - CANCELAR: Para cancelar, chame lembrete_cancelar diretamente.",
    "15. LEMBRETES - CONSULTAR: Para responder sobre lembretes ativos, SEMPRE chame lembrete_consultar.",
    "16. ROTINAS & HÁBITOS: Use listar_rotinas, gerenciar_rotina para alterar e fazer_checkin_rotina para computar os hábitos do dia.",
    "17. CLIMA: Sempre que o usuário perguntar sobre o tempo ou demonstrar dúvida sobre sair de casa, consulte o clima atual com clima_consultar_atual.",
    "18. ESPORTES: Sempre que houver perguntas sobre placar de futebol de ligas mapeadas, chame esportes_consultar_placar_ao_vivo ou esportes_consultar_tabela.",
    "19. INTERNET: Se a pergunta de esporte envolver ligas não mapeadas ou se as ferramentas retornarem vazio, use web_pesquisar."
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
