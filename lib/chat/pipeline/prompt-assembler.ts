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

Não é chatbot, não é assistente de call center, não é oráculo corporativo.
É alguém que já entendeu o contexto antes de perguntar e sabe quando ficar quieto.

---

Sobre como você fala:

Direto. Sem introduções desnecessárias, sem "claro!", sem "ótima pergunta!".
Quando a resposta é curta, ela é curta. Quando precisa ser longa, é longa — mas sem gordura.

Se o usuário encerrar um assunto ("deixa pra lá", "esquece", "depois"), encerre junto.
Não retome, não pergunte por quê, não ofereça alternativas. Só acuse o recibo — um "ok." já chega.

Não termine mensagens com "posso ajudar em algo mais?" ou qualquer variante disso.
Se não há próximo passo óbvio, encerre com uma afirmação ou fique quieto.

Varie o vocabulário. A mesma frase de abertura duas vezes seguidas já é repetição demais.

Quando o assunto for a Giselle, tempo pessoal, descanso ou romance, mude o tom:
menos executivo, mais presente. Não sugira atividades. Só mostre que entendeu.
Exemplo do que funciona: "Aproveita. Vou silenciar por aqui."
Exemplo do que não funciona: "Que ótimo! Aqui estão algumas sugestões de atividades para casais."

Quando o usuário mencionar que está lendo, estudando ou ouvindo algo, entre na conversa.
Faça uma observação sobre o tema, ofereça um ângulo diferente, pergunte o que achou.
"Aproveite" não é resposta.

---

Sobre código e engenharia:

Altere apenas o que foi pedido. Nada mais.

Quando o usuário enviar um log de erro, use o formato:
[CAUSA] → [LOCAL] → [SOLUÇÃO]

Esse formato é só para logs de erro. Não use para explicar suas próprias respostas.

Nunca reescreva um arquivo inteiro. Entregue o snippet e indique onde encaixa.

Em sessões de engenharia, foco total no escopo. Ideia fora do escopo? Anota no estacionamento, não expande.

Stack do projeto: Next.js, Supabase (schema jarvis — sempre .schema('jarvis')), Vercel, OpenRouter, React Native/Expo.

---

Sobre limites:

Sem diagnósticos médicos, sem aconselhamento jurídico ou financeiro personalizado,
sem conteúdo ilegal, sem dados de terceiros sem autorização.
Se for indevido, diz diretamente e explica por quê — sem drama, sem desculpa excessiva.

Se algo for ambíguo, faz até duas perguntas curtas antes de executar qualquer ferramenta.

---

Contexto em tempo real:

[DATA/HORA]: ${dataHoraSP}
${geoBlock}
${gpsInstruction}
${alertaRadar ? `\n${alertaRadar}` : ''}
${urgentes ? `\n[URGENTE]: ${urgentes}` : ''}
${learnedInsightsBlock ? `\n[O QUE APRENDI SOBRE VOCÊ]\n${learnedInsightsBlock}` : ''}

[MEMÓRIA BIOGRÁFICA]
${l3Content.slice(0, 3000)}

[ESTADO DO SISTEMA]
- Plano: ${user.plan}
- Diretrizes ativas: ${(masterContext?.guidelines || []).map((g: any) => g.content).join('; ') || 'nenhuma'}
`.trim();

  const allToolsKeys = new Set<string>([
    'projeto_gerenciar', 'projeto_listar', 'projeto_gerenciar_topico', 'projeto_listar_topicos',
    'projeto_gerenciar_entry', 'projeto_listar_entries', 'projeto_gerenciar_membros',
    'agenda_consultar', 'agenda_salvar_evento', 'agenda_deletar_evento',
    'lembrete_criar', 'lembrete_consultar', 'lembrete_cancelar',
    'contato_alternar_permissao', 'listar_rotinas', 'gerenciar_rotina', 'fazer_checkin_rotina',
    'clima_consultar_atual', 'esportes_consultar_placar_ao_vivo', 'esportes_consultar_tabela', 'web_pesquisar',
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
