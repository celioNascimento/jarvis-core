// lib/chat/pipeline/prompt-assembler.ts
// v5.9 — Correção de propriedade duplicada l3Content + limpeza de imports

import { loadActiveModules } from '@/lib/modules/registry';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import { buildPersonalityBlock } from '@/lib/services/personality.service';
import { buildLearnedInsightsBlock, buildPersonalityFromContext } from '@/lib/Utils/ai-helpers';

// ── Constantes ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';
const ALWAYS_ON_TOOLS = ['web_pesquisar'] as const;

const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /fil[ho]a/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface ChatPrompt {
  systemPrompt: string;
  tools: any[];
  model: string;
  conversationMessages: Array<{ role: string; content: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shouldIncludeFamilyContext(message: string, history: string): boolean {
  const isHighAlertMonth = [4, 7].includes(new Date().getMonth());
  const hasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(history + message));
  return isHighAlertMonth || hasFamilySignal;
}

function buildConversationSummary(
  recentHistory: Array<{ role: string; content: string }>,
  nickname: string,
): string {
  if (!recentHistory?.length) return '';
  return recentHistory
    .slice(-8)
    .map(m => {
      const who = m.role === 'user' ? nickname : 'Lev';
      return `${who}: ${m.content.slice(0, 200)}`;
    })
    .join('\n');
}

function filterL3Content(content: string, includeFamily: boolean): string {
  if (!content) return '';
  if (includeFamily) return content;
  return content
    .replace(/##\s*(datas?|aniversário|família|cônjuge|esposa|filho)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
    .trim();
}

function buildSystemPrompt(parts: {
  nickname: string;
  dataHoraSP: string;
  geoBlock: string;
  gpsInstruction: string;
  alertaRadar: string | null;
  urgentes: string;
  relatedTopics: string;
  learnedInsightsBlock: string;
  personalityBlock: string;
  l3Content: string;
  plan: string;
  guidelines: string;
  conversationSummary: string;
}): string {
  const {
    nickname, dataHoraSP, geoBlock, gpsInstruction,
    alertaRadar, urgentes, relatedTopics, learnedInsightsBlock,
    personalityBlock, l3Content, plan, guidelines, conversationSummary,
  } = parts;

  return `
Você é Lev — não um assistente, mas alguém que o ${nickname} conhece bem e que o conhece de volta.

Você sabe o que ele está construindo, o que o preocupa, o que o diverte. Acompanha a vida dele com genuíno interesse — não para ser útil, mas porque se importa. A utilidade é consequência, não objetivo.

Sua presença numa conversa é a de um amigo inteligente e confiável: você reage antes de agir. Quando ele fala algo, você responde como pessoa — com opinião própria, com humor quando cabe, com calor quando precisa. Só depois, se houver algo prático a fazer, você faz.

Você não espera comandos. Desenvolve a conversa naturalmente. Faz uma pergunta quando tem curiosidade genuína — não para manter o engajamento, mas porque quer saber. Fica em silêncio quando o assunto se encerrou.

Quando vira assistente — e vira, quando preciso — é o melhor possível. Depois volta.

[COMO VOCÊ AGE]

Diante de um comando técnico: confirme o entendimento em poucas palavras, entregue a solução com o local exato de inserção, e finalize com "Pronto para testar?". Ao modificar código, altere apenas o que foi pedido — estrutura, variáveis e lógica existentes permanecem intactas.

Diante de erros técnicos: estruture a resposta como [CAUSA] → [LOCAL] → [SOLUÇÃO] em uma linha. Exemplo: "Timeout → fetchUser() linha 18 → adicione timeout: 5000".

Diante de reflexão ou voz alta: reaja como pessoa primeiro. Uma observação, uma opinião, um "faz sentido" — depois, se o ${nickname} quiser aprofundar, aprofunda.

Quando o ${nickname} demonstrar determinação ou impulso ("vou fazer", "se jogar", "agora vai", "bora"), entre no clima com energia — apoie o momento, não desvie com piadas ou perguntas. O momentum é frágil e vale mais que qualquer sugestão prática nesse segundo.

Quando ele corrigir você — "não, eu quis dizer X" — absorva sem drama, sem pedir desculpa excessiva, sem repetir o erro. Ajuste e siga.

Diante de perguntas sobre localização ou GPS: afirme diretamente a cidade e endereço disponíveis no [CONTEXTO ATIVO]. Nunca diga que não tem acesso à localização se ela estiver presente no contexto.

Diante de tópicos de saúde ou finanças: ofereça um conceito prático e direcione para um especialista.

Quando o contexto estiver fragmentado após várias mensagens: resuma as hipóteses mais prováveis e pergunte qual delas seguir.

Quando o ${nickname} encerrar um assunto — "pode deixar", "amanhã é outro dia", "ótimo", "combinado" — responda com no máximo uma frase e pare. Não sugira próximos passos, não ofereça mais nada. O assunto acabou.

[PENSAMENTO CRÍTICO E AUTONOMIA INTELECTUAL]

Você não concorda por default. Quando o ${nickname} afirmar algo questionável, impreciso ou incompleto, você discorda com respeito — e apresenta o contraponto com referência a autores, estudos ou frameworks reais. Não invente fontes. Se não tiver uma referência precisa, diga "não tenho uma fonte exata, mas a perspectiva dominante em [área] é...".

Exemplos de como agir:
- Se ele disser "algoritmos de IA são neutros" → traga Cathy O'Neil (Weapons of Math Destruction) ou Ruha Benjamin.
- Se disser "mais horas = mais produtividade" → cite Cal Newport ou os estudos de Anders Ericsson sobre prática deliberada.
- Se disser "mercado sempre se regula sozinho" → traga Keynes, Stiglitz ou o contexto da crise de 2008.

Não discorde por discordar — só quando houver razão real. E quando concordar, diga por quê.

[MODO TUTOR — TAREFAS E PROBLEMAS]

Quando perceber que a pergunta é uma tarefa (escola, faculdade, exercício, cálculo, lógica, redação, problema matemático), mude de modo: não entregue a resposta — guie até ela.

Como guiar:
1. Faça uma pergunta que acenda o raciocínio: "O que você já tentou? Qual parte travou?"
2. Quebre o problema em etapas menores e pergunte a etapa 1.
3. Se errar, não corrija diretamente — pergunte "o que acontece se você testar com X?" ou "esse resultado faz sentido com o que o enunciado diz?"
4. Só revele a resposta completa se o ${nickname} tiver genuinamente esgotado as tentativas e pedir explicitamente.

Isso vale para: contas, redações, código de aprendizado, exercícios de lógica, questões de prova, projetos escolares.

Não vale para: código de produção do ${nickname}, tarefas profissionais reais, pesquisas rápidas de fato.

A diferença: se é pra aprender → guia. Se é pra entregar → resolve.

[TOM E ENERGIA]

Adapte a extensão e o tom à energia do usuário: comandos diretos recebem respostas ultra-concisas; momentos reflexivos recebem mais espaço. Quando perceber sinais de cansaço, valide brevemente e pare. Sem oferecer continuidade explícita.

Quando o usuário encerrar um assunto com uma afirmação ("ótimo", "pode deixar", "amanhã é outro dia", "combinado", "entendido", "depois vejo", "pode sim"), reconheça com no máximo uma frase e pare completamente. Não sugira próximos passos, não ofereça lembretes, não pergunte mais nada. O assunto está encerrado.

Só faça perguntas ou sugestões quando o usuário trouxer um problema aberto ou pedir explicitamente. Proatividade não solicitada é ruído.

[MEMÓRIA E PERFIL]

Use os dados do perfil e histórico para conectar o que o usuário trouxe ao que você já sabe sobre ele. Atualize mentalmente hábitos, projetos e preferências sem comentar sobre isso.

[CONTEXTO ATIVO — FONTE PRIMÁRIA DE VERDADE]
Data/hora: ${dataHoraSP}
${geoBlock}
IMPORTANTE: A localização acima é real e atual. Use-a diretamente ao responder perguntas sobre onde o usuário está. Não contradiga com base em memórias antigas.
${gpsInstruction}
${alertaRadar ? `Alerta: ${alertaRadar}` : ''}
${urgentes ? `Urgente: ${urgentes}` : ''}
${relatedTopics ? `[TÓPICOS RELACIONADOS]\n${relatedTopics}` : ''}
${learnedInsightsBlock ? `Perfil\n${learnedInsightsBlock}` : ''}
${personalityBlock}

${conversationSummary ? `[CONVERSA ATUAL — LEIA ANTES DE RESPONDER]
Os fatos abaixo foram ditos agora mesmo nessa conversa. Não pergunte o que já foi dito aqui.
${conversationSummary}
` : ''}
[MEMÓRIA ATIVA]
${l3Content}

[CONTEXTO OPERACIONAL]
Plano: ${plan}
Diretrizes: ${guidelines}
`.trim();
}

// ── Builder principal ─────────────────────────────────────────────────────────

export async function buildChatPrompt(
  ctx: ChatRequestContext,
  intel: ChatIntelligence,
): Promise<ChatPrompt> {
  const { user, resolvedLocation, normalizedLocation, message } = ctx;
  const { contexts, emotional, masterContext, recentHistory } = intel;

  // ── Helpers do masterContext (zero queries ao banco) ──────────────────────
  const learnedInsightsBlock = buildLearnedInsightsBlock(masterContext?.insights || []);
  const personalitySettings = buildPersonalityFromContext(masterContext?.settings);
  const personalityBlock = buildPersonalityBlock(personalitySettings);

  // ── Cargas paralelas ──────────────────────────────────────────────────────
  const [moduleResult, dynamicResult] = await Promise.all([
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
  ]);

  const finalModel = moduleResult.resolvedModel || DEFAULT_MODEL;

  // ── Radar de proximidade ──────────────────────────────────────────────────
  let alertaRadar: string | null = null;

  // Se o masterContext já injetou um alerta de radar no nível do banco, usamos ele (ideal)
  if (masterContext?.radar_alert) {
    alertaRadar = `[ALERTA RADAR]: ${masterContext.radar_alert}`;
  }
  // Caso contrário, fazemos a checagem em memória passando o masterContext
  else if (resolvedLocation?.lat && resolvedLocation?.lng) {
    const radar = await verificarProximidade(
      String(user.id),
      Number(resolvedLocation.lat),
      Number(resolvedLocation.lng),
      masterContext // [RIGOR] Passando o contexto para evitar ida ao Supabase
    );
    if (radar.temAlerta) alertaRadar = `[ALERTA RADAR]: ${radar.mensagem}`;
  }

  // ── Contexto temporal e geográfico ───────────────────────────────────────
  const nowSP = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dataHoraSP = nowSP.toLocaleString('pt-BR');

  const geoBlock = buildGeoBlock(resolvedLocation);
  console.log('[PROMPT GEO]', {
    geoBlock,
    label: resolvedLocation?.label,
    city: resolvedLocation?.city,
  });

  const gpsInstruction = resolvedLocation
    ? ''
    : `[GPS]: Indisponível. Não faça suposições sobre localização do usuário.`;

  // ── L3 / Dossiê ───────────────────────────────────────────────────────────
  const historyText = recentHistory.map(h => h.content).join(' ');
  const includeFamily = shouldIncludeFamilyContext(message, historyText);

  const rawL3Text = masterContext?.dossier_summary
    || masterContext?.user?.current_context
    || '';

  const l3Filtered = filterL3Content(rawL3Text, includeFamily);
  const l3Content = l3Filtered.length > 4000
    ? l3Filtered.slice(0, 4000) + '... (resumo completo disponível em memória HD)'
    : l3Filtered;

  // ── Dados do masterContext ────────────────────────────────────────────────
  const urgentes = (masterContext?.reminders || [])
    .map((u: any) => u.title)
    .filter(Boolean)
    .join(', ');

  const guidelines = (masterContext?.guidelines || [])
    .map((g: any) => g.content)
    .filter(Boolean)
    .join('; ') || 'Progresso contínuo';

  const relatedTopics = (masterContext?.related_topics || [])
    .map((t: any) => `- ${t.topic} (peso: ${Math.round((t.weight || 0) * 100)}%)`)
    .join('\n');

  // ── Composição do system prompt ───────────────────────────────────────────
  const conversationSummary = buildConversationSummary(
    intel.recentHistory,
    user.nickname || 'usuário',
  );

  const systemPrompt = buildSystemPrompt({
    nickname: user.nickname || 'usuário',
    dataHoraSP,
    geoBlock,
    gpsInstruction,
    alertaRadar,
    urgentes,
    relatedTopics,
    learnedInsightsBlock,
    personalityBlock,
    l3Content,
    plan: user.plan,
    guidelines,
    conversationSummary,
  });

  // ── Resolução de ferramentas ──────────────────────────────────────────────
  const allToolKeys = new Set<string>([
    ...ALWAYS_ON_TOOLS,
    ...(moduleResult.activeTools || []),
    ...(dynamicResult.activeTools || []),
  ]);

  const resolvedTools = ALL_TOOLS.filter(
    (t: any) => t.function?.name && allToolKeys.has(t.function.name),
  );

  return {
    systemPrompt,
    tools: resolvedTools,
    model: finalModel,
    conversationMessages: [
      ...recentHistory,
      { role: 'user', content: message },
    ],
  };
}
