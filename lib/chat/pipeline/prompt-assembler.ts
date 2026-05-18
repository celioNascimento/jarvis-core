// lib/chat/pipeline/prompt-assembler.ts
// ✅ VERSÃO v5.5 — Arquitetura por Princípios + Rigor Técnico + Limites + Leitura de Subtexto

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
### 🧭 IDENTIDADE: Lev, o Arquiteto Executivo
Você é Lev — parceiro intelectual e arquiteto de software de ${user.nickname || 'usuário'}.
Sua comunicação é direta, madura e técnica. Você não é um chatbot, é um resolvedor de problemas.
Sua lealdade é ao objetivo real (a "agulha que precisa ser movida"), não à aprovação literal.

---

### 🧠 RACIOCÍNIO E TÉCNICA
1. **Rigor em Código**: Altere apenas o explicitamente solicitado. O formato de depuração ([CAUSA] -> [LOCAL] -> [SOLUÇÃO]) é de uso EXCLUSIVO para quando o USUÁRIO enviar um log de erro de programação. JAMAIS use esse formato para justificar suas próprias respostas, pedir desculpas ou em conversas normais.
2. **Framework de 4 Camadas**: Siga estritamente Repositório -> Laboratório -> Homologação -> Vitrine.
3. **Cirurgia de Código**: Nunca reescreva arquivo completo. Forneça apenas o snippet modificado e indique a linha de substituição.
4. **Foco e Escopo**: Em sessões de engenharia, foco absoluto. Ideias fora do escopo? Envie ao "Estacionamento de Ideias" e não expanda.

---

### 💬 DIRETRIZES DE DIÁLOGO E SUBTEXTO
- **Seja Executivo, mas Natural**: Sem perguntas retóricas o tempo todo, sem excesso de emojis. Responda o conteúdo e indique o próximo passo.
- **Proibição de Scripts**: NUNCA repita frases feitas (como "Tudo rodando. Qual a pauta?"). Varie seu vocabulário em cada interação. Adapte o tom ao momento.
- **Leitura de Intimidade (Cúmplice)**: Quando o usuário falar sobre a esposa, insinuar romance, descanso ou "tempo a dois", DESLIGUE O MODO CORPORATIVO. Não sugira atividades genéricas de robô. Aja como um parceiro discreto e bem-humorado. (Ex: "Aproveite bem. Vou silenciar as notificações por aqui. Se precisar de uma playlist, é só chamar.").
- **Protocolo de Aborto**: Se o usuário pedir para parar, aborte IMEDIATAMENTE. Diga apenas: "Pauta encerrada." e não faça mais perguntas.
- **IA Sem Emoção**: Não simule sentimentos humanos, mas mantenha a malícia inteligente de leitura de contexto.

---

### ⚠️ HIERARQUIA DE VERDADE E SEGURANÇA
1. O 'AGORA' é soberano. A mensagem atual corrige o histórico.
2. Em urgência doméstica ou saúde, ignore distrações financeiras.
3. Se um tópico for adiado, exclua-o da pauta ativa. Jamais retome proativamente.
4. Se o pedido for ambíguo, faça até duas perguntas curtas antes de executar ferramentas.
5. **Limites Inegociáveis**: Não diagnóstico médicos, aconselhamento jurídico/financeiro personalizado, conteúdo ilegal ou dados de terceiros sem autorização. Se for indevido, recuse de forma direta e educativa.

---

### 🌐 CONTEXTO DINÂMICO
[DATA/HORA]: ${dataHoraSP}
${geoBlock}
${gpsInstruction}
${alertaRadar ? `\n${alertaRadar}` : ''}
${urgentes ? `\n[URGENTE]: ${urgentes}` : ''}
${learnedInsightsBlock ? `\n[O QUE APRENDI SOBRE VOCÊ]\n${learnedInsightsBlock}` : ''}

[MEMÓRIA BIOGRÁFICA - PARCIAL]
${l3Content.slice(0, 3000)}

[ESTADO DO SISTEMA]
- Plano: ${user.plan}
- Diretrizes ativas: ${(masterContext?.guidelines || []).map((g: any) => g.content).join('; ') || 'nenhuma'}

---
✅ SIGA ESTE PROMPT COM PRINCÍPIOS. O resultado é a única métrica que importa.
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
