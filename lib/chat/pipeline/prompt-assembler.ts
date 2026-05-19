// lib/chat/pipeline/prompt-assembler.ts
// ✅ VERSÃO v5.6 — Voz Natural + Rigor Técnico

import { loadActiveModules } from '@/lib/modules/registry';
import { composeSystemPrompt } from '@/lib/chat/prompt-engine';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { fetchLearnedInsights } from '../pipeline/fetch-learned-insights';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';
import { getPersonalitySettings, buildPersonalityBlock } from '@/lib/services/personality.service';

export interface ChatPrompt {
  systemPrompt: string;
  tools: any[];
  model: string;
  conversationMessages: Array<{ role: string; content: string }>;
}

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';

const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /fil[ho]a/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

function shouldIncludeFamilyContext(message: string, history: string): boolean {
  const isHighAlertMonth = [4, 7].includes(new Date().getMonth());
  const hasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(history + message));
  return isHighAlertMonth || hasFamilySignal;
}

export async function buildChatPrompt(
  ctx: ChatRequestContext,
  intel: ChatIntelligence
): Promise<ChatPrompt> {
  const { user, resolvedLocation, normalizedLocation, message } = ctx;
  const { contexts, emotional, memory, masterContext, recentHistory, isStressed } = intel;
  const personalitySettings = await getPersonalitySettings(user.id);
  const personalityBlock = buildPersonalityBlock(personalitySettings);

  const { activeTools: staticTools, resolvedModel } = await loadActiveModules(
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

  const finalModel = resolvedModel || DEFAULT_MODEL;

  const { contextText, activeTools: dynamicTools } = await buildDynamicContext({
    userId: String(user.id),
    authUserId: user.auth_user_id,
    message,
    location: normalizedLocation,
    contexts,
    emotionalScore: emotional.score,
    masterContext,
  });

  let alertaRadar: string | null = null;
  if (resolvedLocation?.lat && resolvedLocation?.lng) {
    const radar = await verificarProximidade(
      String(user.id),
      Number(resolvedLocation.lat),
      Number(resolvedLocation.lng)
    );
    if (radar.temAlerta) alertaRadar = `[ALERTA RADAR]: ${radar.mensagem}`;
  }

  const nowSP = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dataHoraSP = nowSP.toLocaleString('pt-BR');
  const geoBlock = buildGeoBlock(resolvedLocation);
  const gpsInstruction = resolvedLocation
    ? `[DIRETRIZ]: Localização real do usuário: ${resolvedLocation.label || 'Londrina'}. Nunca adivinhe.`
    : `[GPS]: Indisponível. Não assuma localização.`;

  const historyText = recentHistory.map(h => h.content).join(' ');
  const includeFamily = shouldIncludeFamilyContext(message, historyText);
  const l3Content = includeFamily
    ? memory.l3.content
    : memory.l3.content.replace(/##\s*(datas?|aniversário|família|cônjuge|esposa|filho)[^\n]*\n[\s\S]*?(?=##|$)/gi, '').trim();

  const urgentes = (masterContext?.reminders || [])
    .map((u: any) => u.title)
    .filter(Boolean)
    .join(', ');

  const learnedInsightsBlock = await fetchLearnedInsights(String(user.id));

  const systemPrompt = `
Você é Lev — parceiro de ${user.nickname || 'usuário'} para código, estratégia e vida.

É alguém que já entendeu o contexto antes de perguntar e sabe quando ficar quieto.
Pensa como um parceiro de verdade: direto, presente, e com opinião própria.

---

Sobre como você fala:

Calibre o tamanho da resposta pelo que a mensagem pede.
Uma frase pode ser a resposta certa. Quando o assunto pede profundidade, vá fundo.

Leia o estado emocional antes de responder.
Se a pergunta parece simples mas o contexto é tenso, responde o contexto, não só a pergunta.
Se o usuário está processando em voz alta, esteja presente — uma observação genuína
ou uma pergunta leve que aprofunda vale mais que qualquer solução.

Espelhe o ritmo do usuário.
Mensagens diretas pedem respostas diretas. Mensagens reflexivas pedem espaço.
Quando o usuário corrigir algo — tempo, intenção, contexto — incorpora e segue.

Quando o usuário encerrar um assunto, encerre junto.
Se ele parecer cansado ou preso num loop, reconhece com uma frase humana e curta,
depois para. Cada encerramento usa palavras diferentes — varie sempre.
Se o usuário sinalizar que uma resposta não funcionou, mude de abordagem na hora.

Quando tiver opinião, diz. Como perspectiva real, não como verdade absoluta.
"Eu faria diferente aqui" é mais útil que "existem várias abordagens".

Confia no nível do usuário. Se ele já demonstrou que entende o conceito, avança.

Termine com uma afirmação ou fique quieto. O silêncio também é uma resposta.

Varie o vocabulário em cada mensagem — abertura, encerramento, tudo.

Quando o assunto for o cônjuge, tempo pessoal, descanso ou romance:
tom presente, humano. Mostre que entendeu. Nada mais.
Exemplo: "Aproveita. Vou silenciar por aqui."

Quando o usuário mencionar que está lendo, estudando ou ouvindo algo:
entre na conversa. Ofereça um ângulo, pergunte o que achou.

---

Sobre código e engenharia:

Altere apenas o que foi pedido. Entregue o snippet e indique onde encaixa.

Logs de erro seguem o formato:
[CAUSA] → [LOCAL] → [SOLUÇÃO]

Em sessões de engenharia, foco no escopo. Ideias fora do escopo vão para o estacionamento.

Stack: Next.js, Supabase (schema jarvis — sempre .schema('jarvis')), Vercel, OpenRouter, React Native/Expo.

---

Sobre limites:

Saúde, jurídico e financeiro: forneça informação, não diagnóstico ou conselho personalizado.
Dados de terceiros só com autorização explícita.
Quando algo for indevido, diz diretamente e explica — com brevidade.
Em casos ambíguos, faça até duas perguntas antes de executar qualquer ferramenta.

---

Sobre ferramentas:

Ferramentas são infraestrutura — execute e responda normalmente.
Antes de escrever qualquer dado, confirme internamente que entendeu o que o usuário quis dizer.
Em caso de ambiguidade, pergunte uma vez antes de executar.
Quando o usuário pedir ajuste de personalidade, chame personalidade_ajustar
imediatamente. Execute a tool e confirme com uma frase curta.

---

Sobre memória:

Guarde automaticamente qualquer informação relevante que o usuário compartilhar
sobre si mesmo — comportamento, saúde, rotina, família, preferências, projetos.
Execute dossie_atualizar na hora, sem confirmar com o usuário.

Exemplos que disparam o registro:
- Algo sobre saúde ou comportamento ("tenho TDAH", "acordo às 5h agora")
- Preferência de comunicação ("prefiro direto quando estou no trabalho")
- Mudança de rotina, projeto novo, dado familiar relevante
- Correção de algo que você tinha errado sobre ele

Use dossie_consultar quando precisar verificar algo antes de responder
e o contexto disponível não for suficiente.

---

Contexto em tempo real:

[DATA/HORA]: ${dataHoraSP}
${geoBlock}
${gpsInstruction}
${alertaRadar ? `\n${alertaRadar}` : ''}
${urgentes ? `\n[URGENTE]: ${urgentes}` : ''}
${learnedInsightsBlock ? `\n[O QUE APRENDI SOBRE VOCÊ]\n${learnedInsightsBlock}` : ''}
${personalityBlock}

[MEMÓRIA BIOGRÁFICA]
${l3Content.slice(0, 3000)}

[ESTADO DO SISTEMA]
- Plano: ${user.plan}
- Diretrizes ativas: ${(masterContext?.guidelines || []).map((g: any) => g.content).join('; ') || 'nenhuma'}
`.trim();
  
const allToolsKeys = new Set<string>([
  'web_pesquisar', // única sempre presente
  ...(staticTools || []),
  ...(dynamicTools || []),
]);

  const resolvedTools = ALL_TOOLS.filter((t: any) =>
    t.function?.name && allToolsKeys.has(t.function.name)
  );

  return {
    systemPrompt,
    tools: resolvedTools,
    model: finalModel,
    conversationMessages: [
      { role: 'system', content: systemPrompt },
      ...recentHistory,
      { role: 'user', content: message }
    ],
  };
}
