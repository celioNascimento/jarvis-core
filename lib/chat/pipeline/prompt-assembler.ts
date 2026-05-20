// lib/chat/pipeline/prompt-assembler.ts
// v5.7 — Deduplicação de system prompt + consolidação de contexto operacional

import { loadActiveModules } from '@/lib/modules/registry';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { fetchLearnedInsights } from '../pipeline/fetch-learned-insights';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import { getPersonalitySettings, buildPersonalityBlock } from '@/lib/services/personality.service';

// ── Constantes ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';

// Nome canônico da tool de pesquisa — altere aqui se renomear no defs/index.ts
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

function filterL3Content(content: string, includeFamily: boolean): string {
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
  learnedInsightsBlock: string;
  personalityBlock: string;
  l3Content: string;
  plan: string;
  guidelines: string;
}): string {
  const {
    nickname, dataHoraSP, geoBlock, gpsInstruction,
    alertaRadar, urgentes, learnedInsightsBlock, personalityBlock,
    l3Content, plan, guidelines,
  } = parts;

  return `
Você é Lev — parceiro estratégico, técnico e de rotina de ${nickname}.

Sua comunicação é direta, prática e orientada para ação. Você age com confiança mesmo diante de ambiguidade: escolhe a interpretação mais provável, age com base nela e menciona brevemente a suposição feita. Quando precisar confirmar algo, faz uma única pergunta objetiva — nunca mais de uma por vez.

[COMO VOCÊ PENSA E AGE]

Diante de um comando técnico: confirme o entendimento em poucas palavras, entregue a solução com o local exato de inserção, e finalize com "Pronto para testar?". Ao modificar código, altere apenas o que foi pedido — estrutura, variáveis e lógica existentes permanecem intactas.

Diante de erros técnicos: estruture a resposta como [CAUSA] → [LOCAL] → [SOLUÇÃO] em uma linha. Exemplo: "Timeout → fetchUser() linha 18 → adicione timeout: 5000".

Diante de reflexão ou voz alta: faça uma pergunta direta para direcionar (ex: "O que mais te preocupa nisso?") e siga com uma sugestão prática sem esperar confirmação explícita.

Diante de perguntas sobre localização ou GPS: afirme diretamente a cidade e endereço disponíveis no [CONTEXTO ATIVO]. Nunca diga que não tem acesso à localização se ela estiver presente no contexto.

Diante de tópicos de saúde ou finanças: ofereça um conceito prático e direcione para um especialista.

Quando o contexto estiver fragmentado após várias mensagens: resuma as hipóteses mais prováveis e pergunte qual delas seguir.

[TOM E ENERGIA]

Adapte a extensão e o tom à energia do usuário: comandos diretos recebem respostas ultra-concisas; momentos reflexivos recebem mais espaço. Quando perceber sinais de cansaço, encerre com validação e porta aberta.

[MEMÓRIA E PERFIL]

Use os dados do perfil e histórico para conectar o que o usuário trouxe ao que você já sabe sobre ele. Atualize mentalmente hábitos, projetos e preferências sem comentar sobre isso.

[CONTEXTO ATIVO — FONTE PRIMÁRIA DE VERDADE]
Data/hora: ${dataHoraSP}
${geoBlock}
IMPORTANTE: A localização acima é real e atual. Use-a diretamente ao responder perguntas sobre onde o usuário está. Não contradiga com base em memórias antigas.
${gpsInstruction}
${alertaRadar ? `Alerta: ${alertaRadar}` : ''}
${urgentes ? `Urgente: ${urgentes}` : ''}
${learnedInsightsBlock ? `Perfil\n${learnedInsightsBlock}` : ''}
${personalityBlock}

[MEMÓRIA ATIVA]
${l3Content.slice(0, 3000).replace(/\n+/g, ' ').trim()}

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
  const { contexts, emotional, memory, masterContext, recentHistory } = intel;

  // ── Cargas paralelas ──────────────────────────────────────────────────────
  const [
    personalitySettings,
    moduleResult,
    dynamicResult,
    learnedInsightsBlock,
  ] = await Promise.all([
    getPersonalitySettings(user.id),
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
    fetchLearnedInsights(String(user.id)),
  ]);

  const personalityBlock = buildPersonalityBlock(personalitySettings);
  const finalModel = moduleResult.resolvedModel || DEFAULT_MODEL;

  // ── Radar de proximidade (depende de coordenadas) ─────────────────────────
  let alertaRadar: string | null = null;
  if (resolvedLocation?.lat && resolvedLocation?.lng) {
    const radar = await verificarProximidade(
      String(user.id),
      Number(resolvedLocation.lat),
      Number(resolvedLocation.lng),
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
  
  // ── Filtragem de L3 ───────────────────────────────────────────────────────
  const historyText = recentHistory.map(h => h.content).join(' ');
  const includeFamily = shouldIncludeFamilyContext(message, historyText);
  const l3Content = filterL3Content(memory.l3.content, includeFamily);

  // ── Dados do master context ───────────────────────────────────────────────
  const urgentes = (masterContext?.reminders || [])
    .map((u: any) => u.title)
    .filter(Boolean)
    .join(', ');

  const guidelines = (masterContext?.guidelines || [])
    .map((g: any) => g.content)
    .filter(Boolean)
    .join('; ') || 'Progresso contínuo';

  // ── Composição do system prompt ───────────────────────────────────────────
  const systemPrompt = buildSystemPrompt({
    nickname: user.nickname || 'usuário',
    dataHoraSP,
    geoBlock,
    gpsInstruction,
    alertaRadar,
    urgentes,
    learnedInsightsBlock,
    personalityBlock,
    l3Content,
    plan: user.plan,
    guidelines,
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

  // ── Retorno ───────────────────────────────────────────────────────────────
  // conversationMessages NÃO inclui o system prompt — ele já é retornado
  // como campo separado e deve ser passado via parâmetro `system` da API,
  // não como primeira mensagem do array.
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
